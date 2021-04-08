// Copyright 2020 Breakside Inc.
//
// Licensed under the Breakside Public License, Version 1.0 (the "License");
// you may not use this file except in compliance with the License.
// If a copy of the License was not distributed with this file, you may
// obtain a copy at
//
//     http://breakside.io/licenses/LICENSE-1.0.txt
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// #import Foundation
// #import "Printer.js"
// #import DOM
// #import CSSOM
// #import "Markdown.js"
"use strict";

JSClass("Builder", JSObject, {

    site: null,
    printer: null,
    debug: false,
    buildLabel: null,
    buildsRootURL: null,
    buildURL: null,
    wwwURL: null,
    s3URL: null,
    s3Sources: null,

    initWithSite: function(site, fileManager){
        this.site = site;
        this.fileManager = fileManager;
        this.printer = Printer.initWithLabel("make");
    },

    build: async function(){
        await this.setup();
        await this.site.open();
        await this.findResources();
        await this.publish();
        await this.createS3SyncScript();
        await this.finish();
    },

    setup: async function(){
        if (this.buildLabel === null){
            if (this.debug){
                this.buildLabel = "debug";
            }else{
                this.buildLabel = JSSHA1Hash(new UUID().bytes).hexStringRepresentation();
            }
        }
        this.buildURL = this.buildsRootURL.appendingPathComponent(this.buildLabel, true);
        this.wwwURL = this.buildURL.appendingPathComponent("www", true);
        this.s3URL = this.buildURL.appendingPathComponent("s3", true);
        var exists = await this.fileManager.itemExistsAtURL(this.buildURL);
        if (exists){
            this.printer.setStatus("Cleaning old build...");
            await this.fileManager.removeItemAtURL(this.buildURL);
        }
        await this.fileManager.createDirectoryAtURL(this.buildURL);
        await this.fileManager.createDirectoryAtURL(this.wwwURL);
    },

    urlsBySourcePath: null,

    publish: async function(){
        this.urlsBySourcePath = {};
        this.publishedResources = {};
        this.s3Sources = [];
        var sitemap = this.site.resources.getMetadata("global", (this.site.info.HTMLSitemap || "Sitemap") + ".yaml").value;
        for (let path in sitemap.Paths){
            let sourcePath = sitemap.Paths[path];
            if (!sourcePath.startsWith("->")){
                this.urlsBySourcePath[sourcePath] = JSURL.initWithString(path.substr(1), this.wwwURL);
            }
        }
        for (let path in sitemap.Paths){
            let sourcePath = sitemap.Paths[path];
            if (sourcePath.startsWith("->")){
                await this.publishRedirect(path, sourcePath.substr(2));
            }else{
                let sourceURL = JSURL.initWithString(sourcePath, this.site.url);
                if (sourcePath.fileExtension === ".html" ){
                    await this.publishHTMLDocument(sourceURL, path);
                }else{
                    await this.publishFile(sourceURL, path);
                }
            }
        }
    },

    publishHTMLDocument: async function(sourceURL, path){
        var localizations = this.site.info.HTMLLocalizations;
        for (let language of localizations){
            await this.publishHTMLDocumentForLanguage(sourceURL, path, language, language === localizations[0]);
        }
    },

    publishHTMLDocumentForLanguage: async function(sourceURL, path, language, isDefault){
        let contents = null;
        try{
            contents = await this.fileManager.contentsAtURL(sourceURL);
        }catch (e){
            this.printer.print("warning: no file found at %s\n".sprintf(sourceURL.encodedStringRelativeTo(this.site.url)));
            return;
        }
        let html = contents.stringByDecodingUTF8();
        let parser = new DOMParser();
        let domDocument = parser.parseFromString(html, "text/html");

        var headers = {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Expires": "Thu, 01 Jan 1970 00:00:01 GMT"
        };
        this.site.headersByPath[path] = headers;
        let publishedURL = JSURL.initWithString(path.substr(1), isDefault ? this.wwwURL : this.wwwURL.appendingPathComponent(language, true));
        if (publishedURL.hasDirectoryPath){
            publishedURL.appendPathComponent(this.site.indexName);
        }
        this.s3Sources.push({
            url: publishedURL,
            headers: headers
        });

        let baseURL = publishedURL;

        let visitNode = async function(node){
            if (node.nodeType === DOM.Node.ELEMENT_NODE){
                await visitElement.call(this, node);
            }else if (node.nodeType === DOM.Node.TEXT_NODE){
                await visitTextNode.call(this, node);
            }
        };

        let visitDocument = async function(document){
            if (!document.doctype){
                var doctype = DOM.createDocumentType("html");
                document.insertBefore(doctype, document.documentElement);
            }
            await visitElement.call(this, document.documentElement);
        };

        let visitElement = async function(element){
            var tagName = element.tagName.toLowerCase();
            var fn = willVisit[tagName];
            if (fn){
                await fn.call(this, element);
            }

            var attributes = JSCopy(element.attributes);
            for (let attribute of attributes){
                await visitAttribute.call(this, attribute);
            }

            var children = JSCopy(element.childNodes);
            for (let child of children){
                await visitNode.call(this, child);
            }

            fn = didVisit[tagName];
            if (fn){
                await fn.call(this, element);
            }
        };

        let willVisit = {

            link: async function(link){
                var href = link.getAttribute("href");
                var rel = link.getAttribute("rel");
                var type = link.getAttribute("type");
                if (rel == "x-sitebuilder-include"){
                    if (href !== null){
                        if (type == "text/html"){
                            let sourceElement = await this.elementForRef(href);
                            if (sourceElement !== null){
                                link.ownerDocument.adoptNode(sourceElement);
                                link.parentNode.insertBefore(sourceElement, link);
                                link.parentNode.removeChild(link);
                                await visitElement.call(this, sourceElement);
                            }
                        }else if (type == "text/markdown"){
                            var metadata = this.site.resources.getMetadata(language, href);
                            var contents = await this.fileManager.contentsAtURL(metadata.sourceURL);
                            var text = contents.stringByDecodingUTF8();
                            var markdown = Markdown.initWithString(text);
                            var builder = this;
                            markdown.delegate = {
                                urlForMarkdownLink: function(markdown, link){
                                    var sourcePath = JSURL.initWithString(link, builder.sourceURL).encodedStringRelativeTo(builder.wwwURL);
                                    var url = builder.urlsBySourcePath[sourcePath];
                                    if (url !== undefined){
                                        link = url.encodedStringRelativeTo(baseURL);
                                    }
                                    return JSURL.initWithString(link);
                                },
                            };
                            var elements = markdown.htmlElementsForDocument(link.ownerDocument);
                            for (var i = 0, l = elements.length; i < l; ++i){
                                link.parentNode.insertBefore(elements[i], link);
                            }
                            link.parentNode.removeChild(link);
                        }
                    }
                }
            },
        };

        let didVisit = {

            base: async function(base){
                var href = base.getAttribute("href");
                if (href !== null){
                    baseURL = JSURL.initWithString(href, baseURL);
                }
            },

            head: async function(head){
                var headerMap = JSMIMEHeaderMap();
                var icons = [];
                var charset = null;
                var indentation = "";
                if (head.childNodes.length > 0 && head.childNodes[0].nodeType === DOM.Node.TEXT_NODE){
                    indentation = head.childNodes[0].nodeValue;
                }
                for (let child of head.childNodes){
                    if (child.nodeType === DOM.Node.ELEMENT_NODE){
                        let childName = child.tagName.toLowerCase();
                        if (childName === "meta"){
                            if (child.getAttribute("charset") !== null){
                                charset = child;
                            }
                        }else if (childName === "link"){
                            if (child.getAttribute("rel") === "icon"){
                                icons.push(child);
                            }
                        }
                    }
                }
                if (charset === null){
                    let meta = head.ownerDocument.createElement("meta");
                    meta.setAttribute("charset", "utf-8");
                    head.insertBefore(meta, head.childNodes[0]);
                    head.insertBefore(head.ownerDocument.createTextNode(indentation), meta);
                }
                if (icons.length === 0){
                    var iconNames = this.siteIcons(language);
                    for (let name of iconNames){
                        let metadata = this.site.resources.getMetadata(language, name);
                        let link = head.ownerDocument.createElement("link");
                        let url = await this.publishResource(name, language);
                        if (url !== null){
                            link.setAttribute("rel", "icon");
                            link.setAttribute("type", metadata.mimetype);
                            link.setAttribute("sizes", "%dx%d".sprintf(metadata.image.width, metadata.image.height));
                            link.setAttribute("href", url.encodedStringRelativeTo(baseURL));
                            head.insertBefore(head.ownerDocument.createTextNode(indentation), head.childNodes[head.childNodes.length - 1]);
                            head.insertBefore(link, head.childNodes[head.childNodes.length - 1]);
                        }
                    }
                }
            },

            img: async function(img){
                var src = img.getAttribute("src");
                if (src !== null){
                    let resourceURL = await this.publishResource(src, language);
                    if (resourceURL !== null){
                        img.setAttribute("src", resourceURL.encodedStringRelativeTo(baseURL));
                    }
                }
            },

            script: async function(script){
                var src = script.getAttribute("src");
                if (src !== null){
                    let resourceURL = await this.publishResource(src, language);
                    if (resourceURL !== null){
                        script.setAttribute("src", resourceURL.encodedStringRelativeTo(baseURL));
                    }
                }
            },

            link: async function(link){
                var href = link.getAttribute("href");
                var rel = link.getAttribute("rel");
                if (href !== null){
                    if (rel === "stylesheet" || rel === "icon"){
                        let resourceURL = await this.publishResource(href, language);
                        if (resourceURL !== null){
                            link.setAttribute("href", resourceURL.encodedStringRelativeTo(baseURL));
                        }
                    }else{
                        var sourcePath = JSURL.initWithString(href, this.sourceURL).encodedStringRelativeTo(this.wwwURL);
                        let url = this.urlsBySourcePath[sourcePath];
                        if (url !== undefined){
                            link.setAttribute("href", url.encodedStringRelativeTo(baseURL));
                        }
                    }
                }
            },

            a: async function(a){
                var href = a.getAttribute("href");
                if (href !== null){
                    var sourcePath = JSURL.initWithString(href, this.sourceURL).encodedStringRelativeTo(this.wwwURL);
                    let url = this.urlsBySourcePath[sourcePath];
                    if (url !== undefined){
                        a.setAttribute("href", url.encodedStringRelativeTo(baseURL));
                    }
                }
            },

            style: async function(style){
                var css = "";
                for (let i = 0, l = style.childNodes.length; i < l; ++i){
                    let child = style.childNodes[i];
                    if (child.nodeType !== DOM.Node.TEXT_NODE){
                        throw new Error("Expecting only text children of style element");
                    }
                    css += child.nodeValue;
                }
                let modified = await visitCSS.call(this, css);
                if (modified !== css){
                    while (style.childNodes.length > 1){
                        style.removeChild(style.childNodes[1]);
                    }
                    style.childNodes[0].nodeValue = modified;
                }
            }

        };

        let visitAttribute = async function(attribute){
            if (attribute.name == "style"){
                attribute.value = await visitCSS.call(this, attribute.value);
            }else{
                await visitLocalizableNode.call(this, attribute);
            }
        };

        let visitTextNode = async function(textNode){
            await visitLocalizableNode.call(this, textNode);
        };

        let visitLocalizableNode = async function(node){
            var text = node.nodeValue;
            if (text === null || text === undefined){
                return;
            }
            if (text.length === 0){
                return;
            }
            if (text[0] == "\\"){
                node.nodeValue = text.substr(1);
            }else if (text[0] == "."){
                let key = text.substr(1);
                let table = sourceURL.lastPathComponent.removingFileExtension() + ".strings.yaml";
                let metadata = this.site.resources.getMetadata(language, table);
                if (metadata !== null && (key in metadata.strings)){
                    node.nodeValue = metadata.strings[key];
                }else{
                    metadata = this.site.resources.getMetadata(language, "Localizable.strings.yaml");
                    if (metadata !== null && (key in metadata.strings)){
                        node.nodeValue = metadata.strings[key];
                    }
                }
            }
        };

        let visitCSS = async function(original){
            var tokenizer = CSSTokenizer.init();
            var tokens = tokenizer.tokenize(original);
            var changed = false;
            for (let i = 0, l = tokens.length; i < l; ++i){
                let token = tokens[i];
                if (token instanceof CSSTokenizer.URLToken){
                    let url = await this.publishResource(token.url, language);
                    if (url !== null){
                        changed = true;
                        token.url = url.encodedStringRelativeTo(baseURL);
                    }
                }else if ((token instanceof CSSTokenizer.FunctionToken) && token.name.toLowerCase() == "url"){
                    let args = [];
                    ++i;
                    while (i < l && !(tokens[i] instanceof CSSTokenizer.CloseParenToken)){
                        if (tokens[i] instanceof CSSTokenizer.StringToken){
                            let url = await this.publishResource(tokens[i].value, language);
                            if (url !== null){
                                changed = true;
                                tokens[i].value = url.encodedStringRelativeTo(baseURL);
                            }
                            break;
                        }
                    }
                }
            }
            if (changed){
                var modified = "";
                for (let token of tokens){
                    modified += token.toString();
                }
                return modified;
            }
            return original;
        };

        await visitDocument.call(this, domDocument);

        let serializer = new XMLSerializer();
        html = serializer.serializeToString(domDocument);
        await this.fileManager.createFileAtURL(publishedURL, html.utf8());
    },

    publishFile: async function(sourceURL, path){
        let publishedURL = JSURL.initWithString(path.substr(1), this.wwwURL);
        if (publishedURL.hasDirectoryPath){
            publishedURL.appendPathComponent(this.site.indexName);
        }
        var headers = {
            "Content-Type": contentTypeForExtension(sourceURL.fileExtension),
            "Cache-Control": "max-age=86400",
        };
        this.site.headersByPath[path] = headers;
        this.s3Sources.push({
            url: publishedURL,
            headers: headers
        });
        await this.fileManager.copyItemAtURL(sourceURL, publishedURL);
    },

    findResources: async function(){
        var blacklist = {names: new Set(), extensions: new Set([".html"])};
        var stack = [this.site.url];
        var urls = [];
        while (stack.length > 0){
            let url = stack.shift();
            let entries = await this.fileManager.contentsOfDirectoryAtURL(url);
            for (let i = 0, l = entries.length; i < l; ++i){
                let entry = entries[i];
                let relativeName = entry.url.encodedStringRelativeTo(this.site.url);
                if (entry.name.startsWith(".")) continue;
                if (entry.itemType == JSFileManager.ItemType.directory && entry.name.fileExtension != '.lproj' && entry.name.fileExtension != '.imageset'){
                    if (!blacklist.names.has(relativeName) && !blacklist.extensions.has(entry.name.fileExtension)){
                        stack.push(entry.url);
                    }
                }else{
                    if (!blacklist.names.has(relativeName) && !blacklist.extensions.has(entry.name.fileExtension)){
                        urls.push(entry.url);
                    }
                }
            }
        }
        for (let url of urls){
            await this.site.resources.addResourceAtURL(url);
        }
    },

    publishedResources: null,

    publishResource: async function(name, language){
        if (this.publishedResources === null){
            this.publishedResources = {};
        }
        var metadata = this.site.resources.getMetadata(language, name);
        if (metadata !== null){
            let url = this.publishedResources[metadata.hash];
            if (!url){
                if (metadata.extension === ".css"){
                    if (metadata.sourceURL !== null){
                        metadata = await this.site.resources.addModifiedCSSAtURL(metadata.sourceURL, language);
                    }
                    for (let reference of metadata.references){
                        await this.publishResource(reference, language);
                    }
                }
                url = this.wwwURL.appendingPathComponent("_resources", true);
                url.appendPathComponent(metadata.hash);
                url.appendFileExtension(metadata.extension);
                this.publishedResources[metadata.hash] = url;
                if (metadata.sourceURL !== null){
                    await this.fileManager.copyItemAtURL(metadata.sourceURL, url);
                }else if (metadata.contents !== null){
                    await this.fileManager.createFileAtURL(url, metadata.contents);
                }
                let path = "/" + url.encodedStringRelativeTo(this.wwwURL);
                var headers = {
                    "Content-Type": contentTypeForExtension(metadata.extension),
                    "Cache-Control": "max-age=31536000, immutable"
                };
                this.site.headersByPath[path] = headers;
                this.s3Sources.push({
                    url: url,
                    headers: headers
                });
            }
            return url;
        }
        return null;
    },

    publishRedirect: async function(path, location){
        this.site.redirectsByPath[path] = location;
    },

    siteIcons: function(language){
        var icons = [];
        let setName = this.site.info.HTMLIcon;
        if (setName){
            setName += '.imageset';
            let metadata = this.site.resources.getMetadata(language, "Contents.json", setName);
            let contents = metadata.value;
            let images = contents.images;
            for (let i = 0, l = images.length; i < l; ++i){
                let image = images[i];
                icons.push(setName + "/" + image.filename);
            }
        }
        return icons;
    },

    elementForRef: async function(ref){
        let url = JSURL.initWithString(ref, this.site.url);
        let id = null;
        if (url.encodedFragment !== null){
            id = url.encodedFragment.stringByDecodingUTF8();
        }
        url.encodedFragment = null;
        let contents = await this.fileManager.contentsAtURL(url);
        let html = contents.stringByDecodingUTF8();
        let parser = new DOMParser();
        let domDocument = parser.parseFromString(html, "text/html");
        let stack = [domDocument.documentElement];
        if (!id){
            return stack.pop();
        }
        while (stack.length > 0){
            let node = stack.shift();
            if (node.nodeType === DOM.Node.ELEMENT_NODE){
                if (node.getAttribute("id") == id){
                    return node;
                }
                for (let i = 0, l = node.childNodes.length; i < l; ++i){
                    stack.push(node.childNodes[i]);
                }
            }
        }
        return null;
    },

    createS3SyncScript: async function(){
        var emptyURL = this.s3URL.appendingPathComponent("empty");
        await this.fileManager.createFileAtURL(emptyURL, JSData.initWithLength(0));
        var scriptURL = this.s3URL.appendingPathComponent("sync.sh");
        var lines = [];
        lines.push("#!/bin/sh");
        lines.push("");
        lines.push("S3_ROOT=$1");
        lines.push("S3_KEY_PREFIX=/${S3_ROOT#s3://*/}");
        lines.push("");
        lines.push("if [ -z \"$S3_ROOT\" ]; then");
        lines.push("  echo \"Usage: sync.sh <s3-root-destination-uri>\"");
        lines.push("  exit 1");
        lines.push("fi");
        lines.push("");
        for (let s3Source of this.s3Sources){
            let source = this.fileManager.pathForURL(s3Source.url);
            let destination = s3Source.url.encodedStringRelativeTo(this.wwwURL);
            let cmd = [
                "aws",
                "s3",
                "cp",
                source,
                "${S3_ROOT}/%s".sprintf(destination)
            ];
            let contentType = s3Source.headers["Content-Type"];
            if (contentType){
                cmd.push("--content-type");
                cmd.push('"%s"'.sprintf(contentType.replace('"', '\\"')));
            }
            let cacheControl = s3Source.headers["Cache-Control"];
            if (cacheControl){
                cmd.push("--cache-control");
                cmd.push('"%s"'.sprintf(cacheControl.replace('"', '\\"')));
            }
            let expires = s3Source.headers.Expires;
            if (expires){
                cmd.push("--expires");
                cmd.push('"%s"'.sprintf(expires.replace('"', '\\"')));
            }
            lines.push(cmd.join(" ") + " || exit 1");
        }
        for (let path in this.site.redirectsByPath){
            let url = JSURL.initWithString(this.site.redirectsByPath[path]);
            let cmd = [
                "aws",
                "s3",
                "cp",
                this.fileManager.pathForURL(emptyURL),
                path.endsWith("/") ? "${S3_ROOT}%s%s".sprintf(path, this.site.indexName) : "${S3_ROOT}%s".sprintf(path),
                "--website-redirect"
            ];
            if (url.isAbsolute){
                cmd.push(url.encodedString);
            }else{
                cmd.push("${S3_KEY_PREFIX}%s".sprintf(url.encodedString));
            }
            lines.push(cmd.join(" ") + " || exit 1");
        }
        lines.push("");
        var contents = lines.join("\n").utf8();
        await this.fileManager.createFileAtURL(scriptURL, contents);
        await this.fileManager.makeExecutableAtURL(scriptURL);
    },

    finish: async function(){
        if (!this.debug){
            var buildParentURL = this.buildURL.removingLastPathComponent();
            var latestBuildURL = buildParentURL.appendingPathComponent("latest");
            var exists = await this.fileManager.itemExistsAtURL(latestBuildURL);
            if (exists){
                await this.fileManager.removeItemAtURL(latestBuildURL);
            }
            await this.fileManager.createSymbolicLinkAtURL(latestBuildURL, this.buildURL);
        }
    }

});

var contentTypeForExtension = function(extension){
    switch (extension){
        case ".html":
            return "text/html";
        case ".txt":
            return "text/plain";
        case ".json":
            return "application/json";
        case ".pdf":
            return "application/pdf";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        case ".jpg":
            return "image/jpeg";
        case ".css":
            return "text/css";
        case ".js":
            return "application/javascript";
    }
    return "application/octet-stream";
};
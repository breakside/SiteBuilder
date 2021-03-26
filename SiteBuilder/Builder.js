// #import Foundation
// #import "Printer.js"
// #import DOM
// #import CSSOM
"use strict";

JSClass("Builder", JSObject, {

    site: null,
    printer: null,
    debug: false,
    buildLabel: null,
    buildsRootURL: null,
    buildURL: null,
    wwwURL: null,

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
        var sitemap = this.site.resources.getMetadata(this.site.info.HTMLSitemap || "Sitemap").value;
        for (let path in sitemap.Paths){
            let sourcePath = sitemap.Paths[path];
            this.urlsBySourcePath[sourcePath] = JSURL.initWithString(path.substr(1), this.wwwURL);
        }
        for (let path in sitemap.Paths){
            let sourcePath = sitemap.Paths[path];
            let sourceURL = JSURL.initWithString(sourcePath, this.site.url);
            if (sourcePath.fileExtension === ".html" ){
                await this.publishHTMLDocument(sourceURL, path);
            }else{
                await this.publishFile(sourceURL, path);
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

        this.site.headersByPath[path] = {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Expires": "Thu, 01 Jan 1970 00:00:01 GMT"
        };
        let publishedURL = JSURL.initWithString(path.substr(1), isDefault ? this.wwwURL : this.wwwURL.appendingPathComponent(language, true));
        if (publishedURL.hasDirectoryPath){
            publishedURL.appendPathComponent(this.site.indexName);
        }

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

            var ref = element.getAttribute("ref");
            if (ref !== null){
                let sourceElement = await this.elementForRef(ref);
                if (sourceElement !== null){
                    element.ownerDocument.adoptNode(sourceElement);
                    element.parentNode.insertBefore(sourceElement, element);
                    element.parentNode.removeChild(element);
                    element = sourceElement;
                }
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
                        let metadata = this.site.resources.getLocalizedMetadata(name, language);
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
            if (text.length === 0){
                return;
            }
            if (text[0] == "\\"){
                node.nodeValue = text.substr(1);
            }else if (text[0] == "."){
                let key = text.substr(1);
                let table = sourceURL.lastPathComponent.removingFileExtension() + ".strings";
                let metadata = this.site.resources.getLocalizedMetadata(table, language);
                if (metadata !== null && (key in metadata.strings)){
                    node.nodeValue = metadata.strings[key];
                }else{
                    metadata = this.site.resources.getLocalizedMetadata("Localizable.strings", language);
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
        this.site.headersByPath[path] = {
            "Content-Type": contentTypeForExtension(sourceURL.fileExtension),
            "Cache-Control": "max-age=86400",
        };
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
        var metadata = this.site.resources.getLocalizedMetadata(name, language);
        if (metadata !== null){
            let url = this.publishedResources[metadata.path];
            if (!url){
                url = this.wwwURL.appendingPathComponent("_resources", true);
                url.appendPathComponent(metadata.hash);
                url.appendFileExtension(metadata.path.fileExtension);
                this.publishedResources[metadata.path] = url;
                await this.fileManager.copyItemAtURL(metadata.sourceURL, url);
                let path = "/" + url.encodedStringRelativeTo(this.wwwURL);
                this.site.headersByPath[path] = {
                    "Content-Type": metadata.mimetype || "application/octet-stream",
                    "Cache-Control": "max-age=31536000, immutable"
                };
            }
            return url;
        }
        return null;
    },

    siteIcons: function(language){
        var icons = [];
        let setName = this.site.info.HTMLIcon;
        if (setName){
            setName += '.imageset';
            let metadata = this.site.resources.getLocalizedMetadata('Contents.json', language, setName);
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
        let id = url.encodedFragment.stringByDecodingUTF8();
        url.encodedFragment = null;
        let contents = await this.fileManager.contentsAtURL(url);
        let html = contents.stringByDecodingUTF8();
        let parser = new DOMParser();
        let domDocument = parser.parseFromString(html, "text/html");
        let stack = [domDocument.documentElement];
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
    }
    return "application/octet-stream";
};
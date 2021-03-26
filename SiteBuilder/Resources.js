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
// #import DOM
// #import CSSOM
// #import jsyaml
'use strict';

JSClass("Resources", JSObject, {

    initWithFileManager: function(fileManager){
        this.lookup = {global: {}};
        this.metadata = [];
        this.fileManager = fileManager;
    },

    lookup: null,
    metadata: null,

    addResourceAtURL: async function(url){
        var name = url.lastPathComponent;
        var ext = url.fileExtension;
        if (ext == ".lproj"){
            await this._addLocalization(url);
        }else if (ext == ".imageset"){
            await this._addImageset(url, 'global');
        }else{
            await this._addResource(url, 'global');
        }
    },

    getMetadata: function(lang, name, subdirectory){
        var lookupKey = name;
        if (subdirectory){
            lookupKey = subdirectory + '/' + lookupKey;
        }
        var hits = this.lookup[lang][lookupKey];
        if (hits && hits.length){
            return this.metadata[hits[0]];
        }
        if (lang !== "global"){
            return this.getMetadata("global", name, subdirectory);
        }
        return null;
    },

    _addLocalization: async function(url){
        var lang = url.lastPathComponent.substr(0, url.lastPathComponent.length - 6); // stripping .lproj
        this.lookup[lang] = {};
        var stack = [url];
        while (stack.length > 0){
            let url = stack.shift();
            let entries = await this.fileManager.contentsOfDirectoryAtURL(url);
            let entry;
            for (let i = 0, l = entries.length; i < l; ++i){
                entry = entries[i];
                if (entry.name.startsWith(".")) continue;
                if (entry.itemType == JSFileManager.ItemType.directory){
                    if (entry.name.fileExtension == '.imageset'){
                        this._addImageset(entry.url, lang);
                    }else{
                        stack.push(entry.url);
                    }
                }else{
                    await this._addResource(entry.url, lang);
                }
            }
        }
    },

    _addImageset: async function(url, lang){
        var entries = await this.fileManager.contentsOfDirectoryAtURL(url);
        var entry;
        var subdirectory = url.lastPathComponent;
        for (let i = 0, l = entries.length; i < l; ++i){
            entry = entries[i];
            if (entry.name.startsWith(".")) continue;
            if (entry.itemType != JSFileManager.ItemType.directory){
                await this._addResource(entry.url, lang, subdirectory);
            }
        }
    },

    addModifiedCSSAtURL: async function(url, lang){
        var name = url.lastPathComponent;
        var metadata = this.getMetadata(lang, name);
        if (metadata !== null && metadata.contents !== null){
            return metadata;
        }

        metadata = {
            sourceURL: null,
            contents: null,
            extension: name.fileExtension,
            references: []
        };
        var contents = await this.fileManager.contentsAtURL(url);
        var css = contents.stringByDecodingUTF8();
        var tokenizer = CSSTokenizer.init();
        var tokens = tokenizer.tokenize(css);
        for (let i = 0, l = tokens.length; i < l; ++i){
            let token = tokens[i];
            if (token instanceof CSSTokenizer.URLToken){
                let referencedMetadata = this.getMetadata(lang, token.url);
                if (referencedMetadata !== null){
                    if (referencedMetadata.extension === ".css" && referencedMetadata.sourceURL !== null){
                        referencedMetadata = await this.addModifiedCSSAtURL(referencedMetadata.sourceURL, lang);
                    }
                    metadata.references.push(token.url);
                    token.url = referencedMetadata.hash + referencedMetadata.extension;
                }
            }else if ((token instanceof CSSTokenizer.FunctionToken) && token.name.toLowerCase() == "url"){
                let args = [];
                ++i;
                while (i < l && !(tokens[i] instanceof CSSTokenizer.CloseParenToken)){
                    if (tokens[i] instanceof CSSTokenizer.StringToken){
                        let referencedMetadata = this.getMetadata(lang, tokens[i].value);
                        if (referencedMetadata !== null){
                            if (referencedMetadata.extension === ".css" && referencedMetadata.sourceURL !== null){
                                referencedMetadata = await this.addModifiedCSSAtURL(referencedMetadata.sourceURL, lang);
                            }
                            metadata.references.push(tokens[i].value);
                            tokens[i].value = referencedMetadata.hash + referencedMetadata.extension;
                        }
                        break;
                    }
                }
            }
        }
        if (metadata.references.length > 0){
            var modified = "";
            for (let token of tokens){
                modified += token.toString();
            }
            contents = modified.utf8();
            metadata.contents = contents;

            var lookup = this.lookup[lang];
            if (!(name in lookup)){
                lookup[name] = [];
            }
            lookup[name].push(this.metadata.length);
            this.metadata.push(metadata);
        }else{
            metadata.sourceURL = url;   
        }
        metadata.hash = JSSHA1Hash(contents).hexStringRepresentation();
        return metadata;
    },

    _addResource: async function(url, lang, subdirectory){
        var name = url.lastPathComponent;
        if (subdirectory){
            name = subdirectory + "/" + name;
        }

        // populate metadata
        var contents = await this.fileManager.contentsAtURL(url);
        var hash = JSSHA1Hash(contents);
        var metadata = {
            sourceURL: url,
            contents: null,
            extension: name.fileExtension,
            hash: hash.hexStringRepresentation()
        };
        if (lang != 'global' && name.endsWith('.strings.yaml')){
            this.addStringsMetadata(lang, name, contents, metadata);
        }else{
            var extra = addMetadata[metadata.extension];
            if (extra){
                await extra.call(this, name, contents, metadata);
            }
        }
        
        // Add to lookup
        var lookup = this.lookup[lang];
        if (!(name in lookup)){
            lookup[name] = [];
        }
        lookup[name].push(this.metadata.length);
        this.metadata.push(metadata);
    },

    addStringsMetadata: function(lang, name, contents, metadata){
        var obj = jsyaml.safeLoad(contents.stringByDecodingUTF8());
        var top = obj[lang];
        if (!top){
            throw new Error("%s must have a top level key for '%s'".sprintf(name, lang));
        }
        metadata.strings = {};
        var visit = function(obj, prefix){
            for (var k in obj){
                var v = obj[k];
                if (typeof(v) == "string" || v.length){
                    metadata.strings[prefix + k] = v;
                }else{
                    visit(v, prefix + k + '.');
                }
            }
        };
        visit(top, '');
    }

});

var addMetadata = {
    '.json': async function(name, contents, metadata){
        metadata.value = JSON.parse(contents.stringByDecodingUTF8());
    },

    '.yaml': async function(name, contents, metadata){
        metadata.value = jsyaml.safeLoad(contents.stringByDecodingUTF8());
    },

    '.png': async function(name, contents, metadata){
        if (contents.length >= 24 &&
            // magic
            contents[0] == 0x89 &&
            contents[1] == 0x50 &&
            contents[2] == 0x4E &&
            contents[3] == 0x47 &&
            contents[4] == 0x0D &&
            contents[5] == 0x0A &&
            contents[6] == 0x1A &&
            contents[7] == 0x0A && 

            // IHDR
            contents[12] == 0x49 &&
            contents[13] == 0x48 &&
            contents[14] == 0x44 &&
            contents[15] == 0x52)
        {
            var dataView = contents.dataView();
            metadata.image = {
                width: dataView.getUint32(16),
                height: dataView.getUint32(20)
            };
        }
    },

    '.jpg': async function(name, contents, metadata){
        if (contents.length < 2 || contents[0] != 0xFF || contents[1] != 0xD8){
            // not a jpeg
            return;
        }
        var dataView = contents.dataView();
        var i = 0;
        var b;
        var l = contents.length;
        var blockLength;
        var blockdata;
        while (i < l){
            b = contents[i++];
            if (b != 0xFF){
                // TODO: Error, not at a maker
                return;
            }
            if (i == l){
                // TODO: Error, not enough room for marker
                return;
            }
            b = contents[i++];
            if (b == 0x00){
                // TODO: Error, invalid marker
                return;
            }
            // D0-D9 are standalone markers...make sure not to look for a length
            if (b < 0xD0 || b > 0xD9){
                if (i >= l - 2){
                    // TODO: Error, not enough room for block header
                    return;
                }
                blockLength = dataView.getUint16(i);
                if (i + blockLength > l){
                    // TODO: Error, not enough room for block data
                    return;
                }
                // C0-CF are start of frame blocks, expect for C4 and CC
                // start of frame blocks have image sizes
                if (b >= 0xC0 && b <= 0xCF && b != 0xC4 && b != 0xCC){
                    if (blockLength >= 7){
                        metadata.image = {
                            height: dataView.getUint16(i + 3),
                            width: dataView.getUint16(i + 5)
                        };
                    }
                    return;
                }
                i += blockLength;
            }
        }
    },

    '.svg': async function(name, contents, metadata){
        var xml = contents.stringByDecodingUTF8();
        // SVG icons from fontawesome don't start with xml prologue, so 
        // add one if it looks to be missing
        if (xml.startsWith("<svg ")){
            xml = '<?xml version="1.0" encoding="utf-8"?>\n' + xml;
        }
        if (!xml.startsWith("<?xml")){
            return;
        }
        metadata.image = {
            vector: true
        };
        var parser = new XMLParser();
        parser.parse(xml, {
            beginElement: function(name, prefix, namespace, attributes, isClosed){
                var multiple = {
                    'em': 12,
                    'ex': 24,
                    'px': 1,
                    'in': 72,
                    'cm': 72/2.54,
                    'mm': 72/25.4,
                    'pt': 1,
                    'pc': 12
                };
                var px = function(length){
                    if (length === undefined || length === null){
                        return undefined;
                    }
                    var matches = length.match(/^\s*(\d+)\s*(em|ex|px|in|cm|mm|pt|pc|%)?\s*$/);
                    if (!matches){
                        return undefined;
                    }
                    let n = parseInt(matches[1]);
                    if (!matches[2]){
                        return n;
                    }
                    let unit = matches[2];
                    if (unit == '%'){
                        return undefined;
                    }
                    return multiple[unit] * n;
                };
                if (namespace == 'http://www.w3.org/2000/svg' && name.toLowerCase() == 'svg'){
                    var attrs = {};
                    for (let i = 0, l = attributes.length; i < l; ++i){
                        let attr = attributes[i];
                        if (attr.namespace === null){
                            attrs[attr.name] = attr.value;
                        }
                    }
                    if (attrs.width && attrs.height){
                        metadata.image.width = px(attrs.width);
                        metadata.image.height = px(attrs.height);
                    }else if (attrs.viewBox){
                        var box = attrs.viewBox.split(/\s+/).map(n => parseInt(n));
                        metadata.image.width = box[2];
                        metadata.image.height = box[3];
                    }
                }
                parser.stop();
            }
        });
    }
};

addMetadata['.jpeg'] = addMetadata['.jpg'];
addMetadata['.otf'] = addMetadata['.ttf'];
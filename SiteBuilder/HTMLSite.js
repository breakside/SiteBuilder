// #import Foundation
// #import "Resources.js"
// #import jsyaml
"use strict";

JSClass("HTMLSite", JSObject, {

    fileManager: null,
    resources: null,
    url: null,
    info: null,
    indexName: null,
    headersByPath: null,

    initWithURL: function(url, fileManager){
        this.fileManager = fileManager || JSFileManager.shared;
        this.url = url;
    },

    open: async function(){
        this.resources = Resources.initWithFileManager(this.fileManager);
        var infoURL = this.url.appendingPathComponent("Info.yaml");
        let yaml = await this.fileManager.contentsAtURL(infoURL);
        this.info = jsyaml.safeLoad(yaml.stringByDecodingUTF8());
        this.indexName = this.info.HTMLIndexName || "index.html";
        this.headersByPath = {};
    }

});
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

// #import "Command.js"
// #import "HTMLSite.js"
// #import "Builder.js"
// #import "Printer.js"
"use strict";

const fs = require("fs");
const http = require("http");

JSClass("MakeCommand", Command, {

    name: "make",

    options: {
        site: {kind: "positional", help: "The html site to build"},
        "builds-root":  {default: null, help: "Root folder for builds"},
        "build-label": {default: null, help: "A label for this build"},
        debug: {kind: "flag", help: "Run a debug build"},
        watch: {kind: "flag", help: "Watch for file changes and rebuild automatically"},
        'http-port': {valueType: "integer", default: null, help: "The port on which to run a debug server"},
    },

    printer: null,

    run: async function(){
        this.printer = Printer.initWithLabel('make');

        var siteURL = this.fileManager.urlForPath(this.arguments.site, this.workingDirectoryURL, true);
        var site = HTMLSite.initWithURL(siteURL, this.fileManager);
        var builder = Builder.initWithSite(site, this.fileManager);
        builder.debug = this.arguments.debug;
        builder.printer = this.printer;
        builder.buildLabel = this.arguments["build-label"];

        if (this.arguments["builds-root"]){
            builder.buildsRootURL = this.fileManager.urlForPath(this.arguments['builds-root'], this.workingDirectoryURL, true);
        }else{
            builder.buildsRootURL = this.workingDirectoryURL.appendingPathComponent('builds', true);
        }

        this.printer.setStatus("Starting...");
        await builder.build();
        if (!this.arguments.watch){
            this.printer.setStatus("Done (build: %s)".sprintf(builder.buildLabel));
        }

        var port = this.arguments['http-port'];
        if (port !== null){
            await this.startHTTPServer(port, builder.wwwURL, builder.site);
            this.printer.print("View site at %s\n".sprintf(this.url.encodedString));
        }

        var error = null;
        while (this.arguments.watch){
            if (error !== null){
                this.printer.setStatus("Failed (%s).  Watching for file changes...".sprintf(error.toString()));
                error = null;
            }else{
                this.printer.setStatus("Done (build: %s).  Watching for file changes...".sprintf(builder.buildLabel));
            }
            await this.watchForChanges(siteURL);
            try{
                await builder.build();
            }catch (e){
                error = e;
            }
        }
        this.printer.print("");
    },

    watchForChanges: async function(siteURL){
        var fileManager = this.fileManager;
        return new Promise(function(resolve, reject){
            var watchers = [];
            var timer = null;
            var handleTimeout = function(){
                for (var i = 0, l = watchers.length; i < l; ++i){
                    watchers[i].close();
                }
                watchers = [];
                resolve();
            };
            var handleChange = function(){
                if (timer !== null){
                    timer.invalidate();
                }
                timer = JSTimer.scheduledTimerWithInterval(1, handleTimeout);
            };
            let path = fileManager.pathForURL(siteURL);
            let watcher = fs.watch(path, {recursive: true}, handleChange);
            watchers.push(watcher);
        });
    },

    url: null,
    httpServer: null,

    startHTTPServer: async function(port, rootURL, site){
        var fileManager = this.fileManager;
        this.httpServer = http.createServer(function(request, response){
            try{
                if (request.method != 'GET'){
                    response.statusCode = JSURLResponse.StatusCode.methodNotAllowed;
                    response.end();
                    return;
                }
                var url = JSURL.initWithString(request.url).standardized();
                var path = url.path;
                if (path === null || path.length === 0 || path[0] != '/'){
                    response.statusCode = JSURLResponse.StatusCode.badRequest;
                    response.end();
                    return;
                }
                var redirectLocation = site.redirectsByPath[path];
                if (redirectLocation){
                    var redirectURL = JSURL.initWithString(redirectLocation, server.url);
                    response.writeHead(JSURLResponse.StatusCode.found, {"Location": redirectURL.encodedString});
                    response.end();
                    return;
                }
                if (path.endsWith("/")){
                    path += site.indexName;
                }
                var relativePath = path.substr(1);
                var fileURL = JSURL.initWithString(relativePath, rootURL);
                var filePath = fileManager.pathForURL(fileURL);
                fs.stat(filePath, function(error, stat){
                    try{
                        if (error){
                            response.statusCode = JSURLResponse.StatusCode.notFound;
                            response.end();
                            return;
                        }
                        response.setHeader("Content-Length", stat.size);
                        response.writeHead(JSURLResponse.StatusCode.ok, site.headersByPath[url.path]);
                        var fp = fs.createReadStream(filePath);
                        fp.pipe(response); // calls .end()
                    }catch(e){
                        process.stdout.write(e.stack);
                        response.statusCode = JSURLResponse.StatusCode.internalServerError;
                        response.end();
                    }
                });
            }catch (e){
                process.stdout.write(e.stack);
                response.statusCode = JSURLResponse.StatusCode.internalServerError;
                response.end();
            }
        });

        var server = this.httpServer;
        port = await new Promise(function(resolve, reject){
            server.listen(port, function(){
                resolve(server.address().port);
            });
        });

        var url = JSURL.initWithString("http://localhost/");
        url.port = port;
        this.url = url;
    },

    stopHTTPServer: function(){
        var server = this.httpServer;
        return new Promise(function(resolve, reject){
            server.close(function(){
                resolve();
            });
        });
    },

});
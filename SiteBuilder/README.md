About
===

SiteBuilder is a utility for compiling HTML and related resources into a
publishable static website.

It was developed as a companion to (and built with) [JSKit](https://github.com/breakside/JSKit),
but targeted for small marketing/landing websites that aren't single-page
applications.

Goals
===

- Completely static websites with developer benefits often only found in server-side processing
- Allow the project files to be organized differently from the published structure
- HTML includes for reusable code like headers and footers
- Bundle all image/js/css resources to cache immutable URLs
- Automatically rewrite any internal links and resource hrefs
- Language file support to auto-generate HTML in multiple languages
- Sync to S3 with Conent-Type and Cache-Control headers

Usage
===

````
$ npm install -D @breakside/sitebuilder
$ npx sitebuilder make MarketingSite
````

[More Documentation](https://github.com/breakside/SiteBuilder)
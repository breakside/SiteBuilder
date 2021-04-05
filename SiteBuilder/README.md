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

Project Organization
====

Every project must have an `Info.yaml` file that contains few instructions for
the project as a whole.

`MarketingSite/Info.yaml`
````
HTMLSitemap: Sitemap   # yaml describing URL paths
HTMLIcon: Icon  # favicon injected into ever page
HTMLIndexName: index.html  # default document name
HTMLLocalizations: [en] # supported languages
````

A `HTMLSitemap` entry is required, and it points to a yaml file that contains
a simple mapping of URL paths to development HTML files.

`MarketingSite/Sitemap.yaml`
````
Paths:
  /:            index/index.html  # all paths are relative to the project root
  /features:    features/features.html
  /terms:       legal/terms.html
  /privacy:     legal/privacy.html
  /contact:     contact/contact.html

# note that there need not be any relationship between the development file
# structure and the URLs
````

HTML Rewriting
====
`sitebuilder` walks the site map and processes each HTML file.

- Any text node that starts with `.` is considered to be a localizable string
- Any `link` with `rel="x-sitebuilder-include"` will be replaced by the referened document
- If a `HTMLIcon` is specified in `Info.yaml`, it will be added as a favicon to every page
  that does not already have a favicon specified
- Any `a` `href` to a project-relative path will be rewritten to its published path
- Any HTML-referenced or CSS-referenced project images, javascript, or style sheets are bundled to unique URLs
  for immutable caching (and references rewritten)

HTML Includes
====
For HTML common to most pages, like headers and footers, you can use a special
`link` tag that `sitebuilder` will replace with the referenced HTML.

````
<link rel="x-sitebuilder-include" type="text/html" href="project/path/to/file.html">
````

The link will be replaced by the HTML from the referenced file, and then the
newly inserted elements will be proceseed.

Project Resources
====
Any project images, javascript, or style sheets that are referenced within HTML or CSS files
are considered resources.

References (HTML `href`/`src` values, CSS `url()` values) to resources are always by filename only, regardless of where the resource
is in the project.  This is because resources are localizable and may exisit in
multiple `.lproj` folders.  The builder chooses the correct resource when building
each langauge.

Localization with .lproj folders
====
Designing an webiste with localization in mind from the start is ideal.

Even if you only provide a single language to begin with, having code that
can easly accomodate other languages saves major headaches down the road.

Every `SiteBuilder` project contains one or more `.lproj` folders.  For example,
you'd create an `en.lproj` folder for English.

Inside `en.lproj` are `.strings.yaml` files that define a mapping of keys to
values:

Perhaps in `index.html` you have a snippet that looks like

````
<html>
<head>
    <title>.title</title>
</head>
<body>
    <h1>.welcome.heading</h1>
    <p>.welcome.text</p>
</body>
</html>
````

`en.lproj/index.strings.yaml` looks like:

````
en:
  title: My Site
  welcome:
    heading: Hello!
    text: This is my site
````

Each file in `en.lproj` is considered a table.  `index.strings.yaml` is
the `index` table, which is the default place that `index.html`
looks for localized strings (each html file looks for a string table with the same
name as the file).  The `Localizable` table is always consulted as a fallback.

To add other lauguages, simply copy the `en.lproj` folder and update the
string tables.

For example, if you wanted to make a spanish translation availble, you'd
1. Copy `en.lproj` to `es.lproj` (`es` for Español).
2. Edit each string table file to start with a top level `es` key instead of
   `en`
3. Change the strings for each key to spanish.


Here's what `es.lproj/index.strings.yaml` would look like:
````
es:
  title: Mi Sitio
  welcome:
    heading: ¡Hola!
    text: Este es mi sitio
````

Markdown
====
Basic markdown conversion can be done by using the same `link` used for HTML
includes, but setting the `type="text/markdown"` and referencing a `.md` file.

The referenced markdown is converted to HTML and replaces the original `link`.
The resulting HTML is not processed any further.
// Minimal RSS 2.0 reader: returns the raw fields of each <item>.
// Enough for well-formed publisher feeds; avoids adding an XML dependency.

function readTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return null;
  return match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function parseRssItems(xml) {
  const items = [];
  for (const [, block] of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    items.push({
      title: readTag(block, "title"),
      link: readTag(block, "link"),
      guid: readTag(block, "guid"),
      pubDate: readTag(block, "pubDate"),
      description: readTag(block, "description"),
      content: readTag(block, "content:encoded"),
      author: readTag(block, "dc:creator") || readTag(block, "author"),
    });
  }
  return items;
}

module.exports = { parseRssItems };

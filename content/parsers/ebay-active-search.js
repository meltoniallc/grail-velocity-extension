/* One observation per result card on an active eBay search. */
(function (global) {
  function parse(doc, ctx) {
    return global.GVParse.cards(doc, ctx, "active_search", "ebay-active-search@1");
  }
  global.GVParse = global.GVParse || {};
  global.GVParse.ebayActiveSearch = parse;
})(globalThis);

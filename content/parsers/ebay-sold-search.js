/* One observation per result card on an eBay sold search (LH_Sold=1). */
(function (global) {
  function parse(doc, ctx) {
    return global.GVParse.cards(doc, ctx, "sold_search", "ebay-sold-search@1");
  }
  global.GVParse = global.GVParse || {};
  global.GVParse.ebaySoldSearch = parse;
})(globalThis);

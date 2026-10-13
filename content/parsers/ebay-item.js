/* eBay item page (/itm/). JSON-LD first, then the specifics table. */
(function (global) {
  function fieldBlock(title, specifics) {
    const card = global.GVCard.extractCardFields(title, specifics);
    return {
      year: card.year,
      set_name: card.setName,
      parallel: card.parallel,
      player: card.player,
      card_no: card.cardNo,
      serial: card.serial,
      is_auto: card.isAuto,
      is_rookie: card.isRookie,
      grade_co: card.gradeCo,
      grade: card.grade,
      cert: card.cert,
      is_print_to_order: card.isPrintToOrder,
    };
  }

  function parse(doc, ctx) {
    const c = global.GVParse.common;
    const observe = global.GVObserve;
    const ld = c.productLd(doc);
    const offer = c.ldOffer(ld);
    const title = (ld && ld.name) || c.text(doc, "h1, #itemTitle, .x-item-title__mainTitle");
    const cleanedTitle = String(title || "").replace(/^Details about\s+/i, "").replace(/\s+/g, " ").trim();
    if (!cleanedTitle) return [];
    const specifics = c.readSpecifics(doc);
    const priceNode = c.text(doc, ".x-price-primary, #prcIsum, .x-bin-price, [itemprop='price']");
    const priceAttr = doc.querySelector("[itemprop='price']");
    const price = c.parsePrice(offer && (offer.price || offer.lowPrice))
      || c.parsePrice(priceAttr && priceAttr.getAttribute("content"))
      || c.parsePrice(priceNode);
    const blob = [
      c.text(doc, "#mainContent, #CenterPanel, body"),
      priceNode,
      c.text(doc, ".x-item-condensed, .x-item-condition, .ux-labels-values--condition"),
    ].join(" ");
    const state = c.statusFrom(blob, "item");
    const format = c.buyingFormat(blob);
    const shipRaw = c.text(doc, ".ux-labels-values--shipping .ux-textspans, #fshippingCost, .vi-acc-del-range");
    const images = [];
    if (ld && ld.image) {
      const list = Array.isArray(ld.image) ? ld.image : [ld.image];
      for (const src of list) {
        if (typeof src === "string" && /^https?:/i.test(src)) images.push(src.split("?")[0]);
      }
    }
    for (const src of c.imagesFrom(doc)) images.push(src);
    const itemId = c.itemIdFromHref(ctx.url) || (ld && (ld.sku || ld.productID)) || "";
    const seller = c.sellerName(doc);
    const feedback = c.feedbackCount(
      doc.querySelector("[data-feedback]")?.getAttribute("data-feedback")
        || c.text(doc, ".x-sellercard-atf__about-seller, .ux-seller-section__item--seller"),
    );
    return [{
      site: "ebay",
      page_type: "item",
      url: observe.cleanEbayUrl(ctx.url),
      item_id: String(itemId || ""),
      title: cleanedTitle,
      price,
      currency: c.currencyFrom(priceNode, offer && offer.priceCurrency),
      shipping: c.shippingFrom(shipRaw),
      buying_format: format.buyingFormat,
      accepted_offer: format.acceptedOffer,
      status: state.status,
      sold_date: state.soldDate,
      condition: c.text(doc, ".x-item-condition-text, #vi-itm-cond, [data-testid='x-item-condition']") || null,
      ...fieldBlock(cleanedTitle, specifics),
      specifics,
      image_urls: [...new Set(images)].slice(0, 12),
      captured_at: new Date(ctx.now || Date.now()).toISOString(),
      extension_version: ctx.version || "",
      parser_ver: "ebay-item@1",
      seller_username: seller,
      feedback_count: feedback,
    }];
  }

  global.GVParse = global.GVParse || {};
  global.GVParse.ebayItem = parse;
})(globalThis);

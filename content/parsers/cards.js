/* Result-card parser shared by sold and active eBay search pages. */
(function (global) {
  function cards(doc, ctx, pageType, parserVer) {
    const c = global.GVParse.common;
    const observe = global.GVObserve;
    const nodes = doc.querySelectorAll(".s-item, .s-card, [data-gv-item]");
    const out = [];
    for (const node of nodes) {
      const title = (
        node.getAttribute("data-gv-title")
        || c.text(node, ".s-item__title, .s-card__title, [role='heading']")
      ).replace(/\s+/g, " ").trim();
      if (!title || /shop on ebay/i.test(title)) continue;
      const link = node.querySelector("a.s-item__link, a.s-card__link, a[href*='/itm/']");
      const href = link ? link.getAttribute("href") || "" : "";
      const itemId = node.getAttribute("data-gv-id") || c.itemIdFromHref(href);
      const priceText = node.getAttribute("data-gv-price") || c.text(node, ".s-item__price, .s-card__price");
      const price = c.parsePrice(priceText);
      if (!price || !itemId) continue;
      const caption = c.text(node, ".s-item__caption, .s-item__ended-date, .POSITIVE, .s-card__caption");
      const shipRaw = c.text(node, ".s-item__shipping, .s-item__logisticsCost, .s-card__logistics");
      const blob = `${caption} ${c.text(node, ".s-item__subtitle, .s-card__subtitle")} ${priceText}`;
      const state = c.statusFrom(`${blob} ${pageType === "sold_search" ? "Sold" : ""}`, pageType);
      const format = c.buyingFormat(`${blob} ${c.text(node, ".s-item__bidCount, .s-item__purchase-options")}`);
      const specifics = {};
      const card = global.GVCard.extractCardFields(title, specifics);
      const seller = c.sellerName(node);
      const feedbackEl = node.querySelector("[data-feedback]");
      out.push({
        site: "ebay",
        page_type: pageType,
        url: observe.cleanEbayUrl(href || ctx.url),
        item_id: String(itemId),
        title,
        price,
        currency: c.currencyFrom(priceText),
        shipping: c.shippingFrom(shipRaw),
        buying_format: format.buyingFormat,
        accepted_offer: format.acceptedOffer || /best offer accepted/i.test(caption),
        status: state.status,
        sold_date: state.soldDate,
        condition: c.text(node, ".SECONDARY_ITEM_CONDITION, .s-card__subtitle") || null,
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
        specifics,
        image_urls: c.imagesFrom(node),
        captured_at: new Date(ctx.now || Date.now()).toISOString(),
        extension_version: ctx.version || "",
        parser_ver: parserVer,
        seller_username: seller,
        feedback_count: c.feedbackCount(
          (feedbackEl && feedbackEl.getAttribute("data-feedback")) || c.text(node, ".s-item__seller-info-text"),
        ),
      });
    }
    return out;
  }

  global.GVParse = global.GVParse || {};
  global.GVParse.cards = cards;
})(globalThis);

/* Grail Velocity — operator UX helpers (overlay, side panel). Classic script. */
(function (global) {
  const GV = global.GV;
  if (!GV) return;

  const OVERLAY_HOST_ID = "grail-velocity-root";

  function findingsText(opts) {
    const query = opts.query;
    const velocity = opts.velocity;
    const pageRows = opts.pageRows || [];
    const soldTape = opts.soldTape || [];
    const money = opts.money || GV.money;
    const cashFromTape = opts.cashFromTape || GV.cashFromTape;
    const keptPage = pageRows.filter((row) => row.keep);
    const keptSold = soldTape.filter((row) => row.keep);
    const fast = cashFromTape(velocity).value;
    const lines = [
      `Grail Velocity — ${query || "(no query)"}`,
      `Action: ${velocity?.action || "QUARANTINE"}`,
      `Fast-Cash: ${money(fast)}`,
      `P25–P75: ${money(velocity?.p25)}–${money(velocity?.p75)}`,
      `Net after fees: ${money(velocity?.netMedian)}`,
      `Page kept: ${keptPage.length}/${pageRows.length}`,
      `Sold kept: ${keptSold.length}/${soldTape.length}`,
      "",
      "Sold tape:",
      ...keptSold.map((r) => `- ${r.title} — ${money(r.price)}`),
    ];
    if (velocity?.reasons?.length) {
      lines.push("", "Why:", ...velocity.reasons.map((r) => `- ${r}`));
    }
    return lines.join("\n");
  }

  function isInsideHost(node, hostId) {
    const id = hostId || OVERLAY_HOST_ID;
    if (!node) return false;
    if (node.id === id) return true;
    if (node.nodeType === 1 && node.closest?.("#" + id)) return true;
    if (node.nodeType === 3 && node.parentElement?.closest?.("#" + id)) return true;
    return false;
  }

  function pageChanged(mutations, hostId) {
    for (const m of mutations || []) {
      if (isInsideHost(m.target, hostId)) continue;
      for (const n of m.addedNodes || []) {
        if (isInsideHost(n, hostId)) continue;
        return true;
      }
      for (const n of m.removedNodes || []) {
        if (isInsideHost(n, hostId)) continue;
        return true;
      }
      if (m.type === "attributes" || m.type === "characterData") return true;
    }
    return false;
  }

  function isOverlayToggleHotkey(e) {
    if (!e || !e.altKey || !e.shiftKey) return false;
    if (e.key !== "g" && e.key !== "G") return false;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return false;
    return true;
  }

  function preserveKeepToggles(rows, prevKeep, queryUnchanged) {
    const list = rows || [];
    if (!queryUnchanged || !prevKeep || !prevKeep.size) return list;
    return list.map((row) => (prevKeep.has(row.id) ? { ...row, keep: prevKeep.get(row.id) } : row));
  }

  function lastReadPayload(opts) {
    const pageRows = opts.pageRows || [];
    const soldTape = opts.soldTape || [];
    const cashFromTape = opts.cashFromTape || GV.cashFromTape;
    const keptSold = soldTape.filter((row) => row.keep);
    return {
      query: opts.query,
      n: soldTape.length || pageRows.length,
      kept: keptSold.length || pageRows.filter((row) => row.keep).length,
      action: opts.velocity?.action || "QUARANTINE",
      fastCash: cashFromTape(opts.velocity).value,
      at: opts.at,
    };
  }

  function formatLastRead(lastRead, now, money) {
    const fmt = money || GV.money;
    if (!lastRead?.at) {
      return "No tab read yet. On eBay: popup → Read this tab, or Alt+Shift+G.";
    }
    const age = Math.max(0, Math.round(((now || Date.now()) - lastRead.at) / 60000));
    const when = age < 1 ? "just now" : age === 1 ? "1m ago" : `${age}m ago`;
    const cash = lastRead.fastCash != null ? " · " + fmt(lastRead.fastCash) : "";
    return `Last read ${when}: ${lastRead.query || "—"} · ${lastRead.kept}/${lastRead.n} kept · ${String(lastRead.action || "").replace("_", " ")}${cash}`;
  }

  function rankCuts(list) {
    return (list || [])
      .filter((i) => i.listPrice && i.fastCash)
      .sort((a, b) => b.listPrice - b.fastCash - (a.listPrice - a.fastCash));
  }

  function queueCopyText(items, money) {
    const fmt = money || GV.money;
    const ranked = rankCuts(items).slice(0, 40);
    if (!ranked.length) return "";
    const header = "id\ttitle\tlist\tfastCash\tgap\n";
    const text = ranked
      .map((i) => {
        const gap = (i.listPrice || 0) - (i.fastCash || 0);
        return `${i.id}\t${i.title}\t${fmt(i.listPrice)}\t${fmt(i.fastCash)}\t${fmt(gap)}`;
      })
      .join("\n");
    return header + text;
  }

  GV.OVERLAY_HOST_ID = OVERLAY_HOST_ID;
  GV.findingsText = findingsText;
  GV.isInsideHost = isInsideHost;
  GV.pageChanged = pageChanged;
  GV.isOverlayToggleHotkey = isOverlayToggleHotkey;
  GV.preserveKeepToggles = preserveKeepToggles;
  GV.lastReadPayload = lastReadPayload;
  GV.formatLastRead = formatLastRead;
  GV.rankCuts = rankCuts;
  GV.queueCopyText = queueCopyText;
})(typeof globalThis !== "undefined" ? globalThis : self);

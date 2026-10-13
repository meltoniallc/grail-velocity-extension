/* Card identity fields from a title plus an item-specifics map. Classic script. */
(function (global) {
  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function specificsMap(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [key, value] of Object.entries(raw)) {
      const name = clean(key).toLowerCase();
      if (!name) continue;
      out[name] = clean(value);
    }
    return out;
  }

  function pick(map, keys) {
    for (const key of keys) {
      if (map[key]) return map[key];
    }
    return "";
  }

  function serialFrom(text) {
    const blob = String(text || "");
    const both = blob.match(/\b(\d{1,4})\s*\/\s*(\d{1,5})\b/);
    if (both) return { serial: `${both[1]}/${both[2]}`, serialDenom: both[2] };
    const denom = blob.match(/(?:^|[\s(])\/\s*(\d{1,5})\b/);
    if (denom) return { serial: `/${denom[1]}`, serialDenom: denom[1] };
    return { serial: "", serialDenom: "" };
  }

  function gradeFrom(text, map) {
    const company = pick(map, ["professional grader", "grader", "grading company"]);
    const grade = pick(map, ["grade", "grade number"]);
    const cert = pick(map, ["certification number", "certification", "cert number", "cert #", "cert"]);
    if (company || grade) {
      return { gradeCo: company.toUpperCase(), grade, cert };
    }
    const match = String(text || "").match(/\b(PSA|BGS|SGC|CGC|CSG|HGA)\s*(\d+(?:\.\d+)?)\b/i);
    if (!match) return { gradeCo: "", grade: "", cert };
    return { gradeCo: match[1].toUpperCase(), grade: match[2], cert };
  }

  function yearFrom(text, map) {
    const fromMap = pick(map, ["year", "season", "year manufactured"]);
    const mapped = fromMap.match(/\d{4}/);
    if (mapped) return mapped[0];
    const match = String(text || "").match(/\b(?:19|20)\d{2}\b/);
    return match ? match[0] : "";
  }

  function cardNoFrom(text, map) {
    const fromMap = pick(map, ["card number", "card #", "card no", "card no."]);
    if (fromMap) return fromMap.replace(/^#/, "");
    const match = String(text || "").match(/#\s*([A-Za-z]?\d{1,4}[A-Za-z]?)/);
    return match ? match[1] : "";
  }

  function flag(text, map, keys, re) {
    const value = pick(map, keys).toLowerCase();
    if (value) return !/^(no|false|n|none)$/.test(value);
    return re.test(String(text || ""));
  }

  function printToOrder(setName, title) {
    return /topps now|bowman now|panini instant/i.test(`${setName || ""} ${title || ""}`);
  }

  function extractCardFields(title, specifics) {
    const map = specificsMap(specifics);
    const text = clean(title);
    const serial = serialFrom(`${text} ${pick(map, ["serial", "serial number", "print run", "limited to"])}`);
    const grade = gradeFrom(text, map);
    const setName = pick(map, ["set", "product", "manufacturer"]);
    const parallel = pick(map, ["parallel", "parallel/variety", "variety"]);
    const player = pick(map, ["player", "player/athlete", "athlete", "character"]);
    return {
      year: yearFrom(text, map),
      setName,
      parallel,
      player,
      cardNo: cardNoFrom(text, map),
      serial: serial.serial,
      serialDenom: serial.serialDenom,
      isAuto: flag(text, map, ["autographed", "autograph", "auto"], /\b(auto|autograph|autographed)\b/i),
      isRookie: flag(text, map, ["rookie", "rookie card"], /\b(rookie|\brc\b)\b/i),
      gradeCo: grade.gradeCo,
      grade: grade.grade,
      cert: grade.cert,
      isPrintToOrder: printToOrder(setName, text),
    };
  }

  global.GVCard = { extractCardFields };
})(globalThis);

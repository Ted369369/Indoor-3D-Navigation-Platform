/*
 * Chat intent engine.
 * Maps free-text queries ("c language", "I want to study Qing dynasty
 * history", "where can I self-study?") to navigation targets using the
 * library's classification scheme (classes 0-9), a curated alias dictionary
 * (English + Chinese), and fuzzy matching (Fuse.js global).
 *
 * Extra terms can be added server-side in the Supabase `keywords` table;
 * they are merged into the dictionary at startup.
 */

const D = []; // dictionary rows: {t, a[], zone?, intent?, note?}
const add = (t, a, target, note) => D.push({ t, a, ...target, note });

/* ---- class 3 science -> 5F-C ------------------------------------------- */
add("programming", ["coding", "software", "computer science", "c language", "c語言",
  "python", "java", "javascript", "程式", "程式設計", "電腦", "資訊"], { zone: "5F-C" });
add("mathematics", ["math", "algebra", "calculus", "數學", "微積分"], { zone: "5F-C" });
add("physics", ["物理", "quantum", "量子"], { zone: "5F-C" });
add("chemistry", ["化學"], { zone: "5F-C" });
add("biology", ["生物", "genetics", "基因"], { zone: "5F-C" });
add("astronomy", ["space", "天文", "宇宙"], { zone: "5F-C" });
add("statistics", ["統計"], { zone: "5F-C" });
add("earth science", ["geology", "地球科學", "地質"], { zone: "5F-C" });

/* ---- class 4 applied science -> 5F-D ------------------------------------ */
add("engineering", ["工程", "mechanical", "機械", "civil engineering", "土木"], { zone: "5F-D" });
add("medicine", ["medical", "健康", "醫學", "醫療", "health"], { zone: "5F-D" });
add("nursing", ["護理"], { zone: "5F-D" });
add("cooking", ["recipes", "cuisine", "食譜", "烹飪", "料理"], { zone: "5F-D" });
add("electronics", ["electrical", "電子", "電機", "arduino", "circuits", "電路"], { zone: "5F-D" });
add("agriculture", ["farming", "農業", "園藝", "gardening"], { zone: "5F-D" });
add("business management", ["management", "企業管理", "管理學", "marketing", "行銷"], { zone: "5F-D" });
add("architecture", ["建築"], { zone: "5F-D" });
add("chinese medicine", ["中醫", "針灸"], { zone: "5F-D" });

/* ---- class 5 social sciences -> 5F-E ------------------------------------ */
add("economics", ["economy", "經濟", "經濟學"], { zone: "5F-E" });
add("finance", ["investment", "金融", "投資", "理財", "stocks", "股票"], { zone: "5F-E" });
add("law", ["legal", "法律", "六法"], { zone: "5F-E" });
add("politics", ["political science", "政治"], { zone: "5F-E" });
add("education", ["teaching", "教育"], { zone: "5F-E" });
add("sociology", ["society", "社會學"], { zone: "5F-E" });
add("military", ["軍事", "war strategy", "兵法"], { zone: "5F-E" });
add("folklore", ["民俗", "customs", "習俗"], { zone: "5F-E" });

/* ---- class 6 Chinese history & geography -> 5F-F ------------------------ */
add("chinese history", ["china history", "中國歷史", "中國史"], { zone: "5F-F" });
add("qing dynasty", ["清朝", "清代", "qing history", "清朝歷史"], { zone: "5F-F" });
add("ming dynasty", ["明朝", "明代"], { zone: "5F-F" });
add("tang dynasty", ["唐朝", "唐代"], { zone: "5F-F" });
add("han dynasty", ["漢朝", "漢代"], { zone: "5F-F" });
add("three kingdoms", ["三國", "三國志"], { zone: "5F-F" });
add("taiwan history", ["台灣歷史", "台灣史", "臺灣史"], { zone: "5F-F" });
add("chinese geography", ["中國地理"], { zone: "5F-F" });

/* ---- class 7 world history & geography -> 4F-A -------------------------- */
add("world history", ["世界歷史", "世界史", "global history"], { zone: "4F-A" });
add("european history", ["歐洲歷史", "europe", "歐洲史"], { zone: "4F-A" });
add("american history", ["美國歷史", "美國史"], { zone: "4F-A" });
add("japanese history", ["日本歷史", "日本史"], { zone: "4F-A" });
add("world war", ["世界大戰", "二戰", "ww2"], { zone: "4F-A" });
add("travel", ["travel guide", "旅遊", "旅行", "自助旅行"], { zone: "4F-A" });
add("world geography", ["世界地理"], { zone: "4F-A" });
add("biography", ["傳記", "memoir", "回憶錄"], { zone: "4F-A" });

/* ---- class 8 language & literature -> 4F-DN ------------------------------ */
add("novels", ["fiction", "小說", "武俠", "romance novels", "言情"], { zone: "4F-DN" });
add("poetry", ["poems", "詩", "詩集", "唐詩"], { zone: "4F-DN" });
add("essays", ["散文", "prose"], { zone: "4F-DN" });
add("chinese literature", ["中國文學", "文學"], { zone: "4F-DN" });
add("english learning", ["learn english", "英語學習", "英文學習", "toeic", "多益"], { zone: "4F-DN" });
add("japanese language", ["learn japanese", "日語", "日文"], { zone: "4F-DN" });
add("linguistics", ["語言學"], { zone: "4F-DN" });

/* ---- class 9 arts -> 4F-B ------------------------------------------------ */
add("art", ["arts", "藝術", "美術"], { zone: "4F-B" });
add("music", ["音樂", "樂譜", "piano", "鋼琴", "guitar", "吉他"], { zone: "4F-B" });
add("painting", ["drawing", "繪畫", "素描", "水彩"], { zone: "4F-B" });
add("photography", ["攝影"], { zone: "4F-B" });
add("design", ["設計"], { zone: "4F-B" });
add("calligraphy", ["書法"], { zone: "4F-B" });
add("movies", ["film", "電影"], { zone: "4F-B" });
add("sports", ["運動", "體育", "fitness", "健身", "yoga", "瑜珈"], { zone: "4F-B" });
add("crafts", ["手工藝", "工藝"], { zone: "4F-B" });
add("dance", ["舞蹈"], { zone: "4F-B" });

/* ---- class 2 religion -> 5F-G -------------------------------------------- */
add("religion", ["宗教"], { zone: "5F-G" });
add("buddhism", ["佛教", "佛學", "禪修", "meditation"], { zone: "5F-G" });
add("christianity", ["基督教", "bible", "聖經", "天主教"], { zone: "5F-G" });
add("taoism", ["道教"], { zone: "5F-G" });
add("mythology", ["神話"], { zone: "5F-G" });
add("fortune telling", ["命理", "占卜", "風水", "astrology", "占星"], { zone: "5F-G" });

/* ---- classes 0-1 general & philosophy -> 5F-H ---------------------------- */
add("philosophy", ["哲學", "尼采", "nietzsche"], { zone: "5F-H" });
add("psychology", ["心理學", "心理"], { zone: "5F-H" });
add("logic", ["邏輯"], { zone: "5F-H" });
add("ethics", ["倫理學", "道德"], { zone: "5F-H" });
add("confucius", ["孔子", "論語", "儒家"], { zone: "5F-H" });
add("encyclopedia", ["百科全書", "百科"], { zone: "5F-H" });
add("dictionaries", ["字典", "辭典"], { zone: "5F-H" });
add("library science", ["圖書館學"], { zone: "5F-H" });

/* ---- special collections & facilities ------------------------------------ */
add("foreign books", ["english books", "外文書", "原文書", "english novels", "英文小說"], { zone: "4F-C" });
add("foreign magazines", ["外文雜誌", "time magazine", "national geographic", "英文雜誌"], { zone: "2F-B" });
add("magazines", ["雜誌", "期刊", "current periodicals", "週刊"], { zone: "2F-E" });
add("academic journals", ["學報", "research papers", "論文", "bound periodicals", "期刊合訂本"], { zone: "2F-F" });
add("compact stacks", ["密集書庫", "archive", "舊書", "書庫"], { zone: "5F-B" },
  "Note: this area requires a reservation.");
add("shanghai window", ["上海之窗", "閱讀北京", "reading beijing", "上海", "北京"], { zone: "5F-I" });
add("resource center", ["北區資源中心", "resource centre"], { zone: "5F-J" });

/* ---- 1F service floor ----------------------------------------------------- */
add("service desk", ["綜合服務臺", "服務台", "information desk", "help desk", "circulation"], { zone: "1F-B" });
add("library card", ["借閱證", "辦證", "register", "membership"], { zone: "1F-B" });
add("borrow book", ["borrow", "checkout", "check out", "借書", "還書", "return book", "歸還"], { zone: "1F-B" });
add("reservation pickup", ["預約取書", "hold pickup", "自助取書"], { zone: "1F-B" });
add("learning e-garden", ["學習e樂園", "學習ｅ樂園", "computers", "internet", "上網", "電腦", "printing", "列印", "print"], { zone: "1F-A" });
add("entrance", ["入口", "lobby", "大廳", "front door", "exit", "出口"], { zone: "1F-ENT" });

/* ---- 3F reference floor --------------------------------------------------- */
add("reference", ["參考", "參考資料", "reference books", "中文參考", "reference room", "參考室"], { zone: "3F-REF" });
add("foreign reference", ["外文參考", "外文參考資料", "foreign language reference"], { zone: "3F-FL" });
add("american corner", ["美國資料中心", "american reference", "美國資料"], { zone: "3F-AC" });
add("study abroad", ["留學", "留學資料中心", "studying overseas", "留學資料"], { zone: "3F-SA" });
add("adult education", ["成人教育", "成人教育資源中心", "continuing education"], { zone: "3F-AE" });
add("maps", ["地圖", "輿圖", "輿圖區", "atlas", "globe", "地圖集"], { zone: "3F-MAP" });
add("microform", ["縮影", "縮影資料", "microfilm", "microfiche"], { zone: "3F-MF" });
add("reference desk", ["諮詢服務臺", "諮詢台", "consultation desk", "reference help"], { zone: "3F-INFO" });
add("photocopying", ["影印", "影印區", "copy", "copier", "photocopy"], { zone: "3F-COPY" });
add("government publications", ["政府出版品", "compact shelves", "密集書庫3", "exam materials", "考試"], { zone: "3F-CS" });

/* ---- functional intents --------------------------------------------------- */
add("latest news", ["news", "newspaper", "時事", "新聞", "報紙", "today's paper", "最新時事"],
  { intent: "newspapers" });
add("self study", ["study", "study room", "reading area", "自習", "自修", "K書", "閱覽",
  "quiet place", "看書", "讀書"], { intent: "nearest_reading" });
add("restroom", ["toilet", "washroom", "bathroom", "廁所", "洗手間", "化妝室"],
  { intent: "nearest_restroom" });
add("elevator", ["lift", "電梯"], { intent: "nearest_elevator" });

const INTENT_TARGETS = {
  newspapers: { candidates: ["2F-C", "2F-A"], lead: "Newspapers and current events are on floor 2." },
  nearest_reading: { candidates: ["4F-F", "5F-A", "2F-A"], lead: "Taking you to the nearest reading area." },
  nearest_restroom: { candidates: ["1F-WC", "2F-WC", "3F-WC", "4F-WC", "5F-WC"], lead: "Taking you to the nearest restroom." },
  nearest_elevator: { candidates: ["1F-ELEV", "2F-ELEV", "3F-ELEV", "4F-ELEV", "5F-ELEV"], lead: "Taking you to the nearest elevator." },
};

export class IntentEngine {
  constructor(model, extraKeywords = []) {
    this.model = model;
    this.zones = {};
    for (const [level, floor] of Object.entries(model.floors)) {
      for (const z of floor.zones) this.zones[z.id] = { ...z, floor: level };
    }
    this.dict = [...D];
    for (const row of extraKeywords) {
      this.dict.push({
        t: row.term,
        a: row.aliases || [],
        zone: row.zone_id || undefined,
        intent: row.intent === "zone" ? undefined : row.intent || undefined,
      });
    }
    this.fuse = new Fuse(this.dict, {
      keys: [{ name: "t", weight: 0.7 }, { name: "a", weight: 0.3 }],
      threshold: 0.34,
      ignoreLocation: true,
      includeScore: true,
    });
  }

  /**
   * Resolve a query to an action.
   * @returns {kind:'zone'|'nearest'|'floor'|'unknown', ...}
   */
  resolve(rawQuery) {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return { kind: "unknown" };

    // explicit floor request: "go to floor 4" / "4樓"
    const floorMatch = q.match(/(?:floor\s*([1-5]))|([1-5])\s*樓/);
    if (floorMatch && q.length < 20) {
      const f = floorMatch[1] || floorMatch[2];
      return {
        kind: "zone", zoneId: `${f}F-ESC`,
        reply: `Heading to floor ${f} - I will route you to its central stairs landing.`,
      };
    }

    // exact alias containment beats fuzzy search
    let hit = null;
    for (const row of this.dict) {
      const terms = [row.t, ...row.a].map((s) => s.toLowerCase());
      if (terms.some((t) => q === t || (t.length >= 2 && q.includes(t)))) { hit = row; break; }
    }
    if (!hit) {
      const results = this.fuse.search(q);
      if (results.length && results[0].score < 0.45) hit = results[0].item;
    }
    if (!hit) return { kind: "unknown", reply: this._unknownReply() };

    if (hit.intent) {
      const spec = INTENT_TARGETS[hit.intent];
      return { kind: "nearest", candidates: spec.candidates, lead: spec.lead, term: hit.t };
    }
    const zone = this.zones[hit.zone];
    const note = hit.note ? ` ${hit.note}` : "";
    return {
      kind: "zone",
      zoneId: hit.zone,
      term: hit.t,
      reply: `"${cap(hit.t)}" is in the ${zone.name} on floor ${zone.floor}.${note} Starting navigation.`,
    };
  }

  /** Autocomplete suggestions while typing. */
  suggest(prefix, limit = 5) {
    const q = prefix.trim().toLowerCase();
    if (q.length < 1) return [];
    const out = [];
    const seen = new Set();
    for (const row of this.dict) {
      for (const term of [row.t, ...row.a]) {
        if (term.toLowerCase().startsWith(q) && !seen.has(row.t)) {
          seen.add(row.t);
          out.push({ label: term, term: row.t });
        }
      }
      if (out.length >= limit) return out;
    }
    for (const r of this.fuse.search(q).slice(0, limit)) {
      if (!seen.has(r.item.t)) {
        seen.add(r.item.t);
        out.push({ label: r.item.t, term: r.item.t });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  _unknownReply() {
    return "I could not match that to a library area. Try a subject like " +
      "\"programming\", \"Qing dynasty history\", \"novels\", or ask for " +
      "\"newspapers\", \"a place to study\", or \"restroom\".";
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

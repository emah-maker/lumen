# Segment marker measurement (real Bergamot engine)

## What this shows

- The marker joins a block's text nodes into one sentence (`features/translate.js`). It only helps if the engine hands it back, so it was measured rather than assumed.
- Numbered `⟦n⟧` is the best single choice for the common case: 8/8 for fr, es and de into English and 7/8 into Arabic. Private-use characters (the first version) are unreliable: 0/8 into Arabic and Persian, 1/8 from Japanese.
- It is not universal: English into Persian lost the markers (0/8; the engine rewrites the digits and brackets, one reply even shows a Persian digit inside the marker, which `splitSegment` reads), and Japanese into English kept 5/8. Other shapes are no better across the board (`<n>` 7/8 into Persian but 5/8 from Japanese; `[[n]]` 5/8 into Persian).
- That is why a bad reply is never trusted: `splitSegment` refuses it and the block is translated node by node. A pair whose markers have never worked trips after 2 bad blocks in a row (3 once they have worked), and then is not grouped for 10 minutes; after that one grouped run probes again, and each failed probe doubles the pause (10, 20, 40, then 60 minutes at most). A probe that works clears it.
- What a bad pair costs, honestly: a request that is already in flight is not stopped, so the trip only takes effect once a whole request has come back. A pair with no history starts with a small first request (about 300 characters, one to three segments), so en to fa pays roughly one small wasted request plus the node-by-node redo of those segments on its first page; later requests are node by node. A failed probe wastes one chunk.
- Bare numbers: a number inside a sentence keeps its value. The engine may reformat it for the target (200 to ٢٠٠, 1,000.5 to 1.000,5, $5.99 to 5,99 €, 1,000 to 1.000), which is accepted: both are parsed as numbers (a mark that repeats, or sits before exactly three digits, is a thousands mark; otherwise it is the decimal mark) and must be equal. Corruption is not accepted and the page keeps what it had: a lost decimal mark (1.5 to 15), an extra or dropped digit (200 to 2000), 1,000 to 1,0. Dates, times and numbers turned into words (2024-05-01 to 01/05/2024, 22:30 to 10:30 PM, 5 to five) are also kept as written but count for nothing. Three corrupt segments in a row switch numbers off for the pair for 10 minutes (then one run probes again; a corrupt number doubles the pause, up to an hour; a clean segment clears it). A symbol-only node (€) that comes back as a word stays as written. The comparison is of signed values: a lost minus sign or brackets (-5 to 5) is corruption, and so are shifted digits in a range (5-10 to 51-0). Words the engine puts inside a number's own part are never written there: the number stays as it was, and if a neighbouring word node came back empty because its words moved into the number, that block is translated node by node instead, so nothing is lost. A lone . or , is read by the languages involved when they are known ("1,234" is 1234 in English but 1.234 for a German target, so writing it unchanged for German is refused); with no language the rule is: three digits after 1 to 3 is thousands, anything else decimal.
- Known limit: even when the markers survive, the engine sees the pieces as fragments of one sentence but may move a word across a marker, so a word can land in a neighbouring element (styling on the next word). The text stays complete; `test/translate-group-units.js` checks that.
- Run it again with `LUMEN_REAL_ENGINE=1 node test/translate-seam-real.js > measurement.md` (it prints only the tables; this page's notes are written by hand, so merge by hand) (it needs the network, about 250 MB for all pairs, and opens no window). Pairs: `PAIRS=fr>en,en>ar` limits it.


Measured 2026-10-02 with `LUMEN_REAL_ENGINE=1 node test/translate-seam-real.js` (plain Node, no window): the app's own `translate-worker.js` and Mozilla's models, Node v24.18.0.
Each sentence is a block's text nodes joined with a candidate seam. "Intact" means every marker came back, once, in order. The shipped row also runs the real `groupItems` and `splitSegment` (it must cut the reply back into the right number of nodes).

## fr to en

Pack fr>en v2.0, 37.2 MB. 8 sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).

| Candidate | Intact |
|---|---|
| private-use U+E000 U+E001 (first version) | 6/8 |
| private-use U+E000 alone | 3/8 |
| double bar ‖ | 5/8 |
| numbered ⟦n⟧ (shipped) | 8/8 |
| numbered [[n]] | 7/8 |
| numbered <n> | 7/8 |
| numbered {n} | 5/8 |
| slash-bar |/| | 7/8 |
| section sign § | 5/8 |

Shipped path (groupItems, engine, splitSegment): 8/8 segments cut back into nodes.

Sample replies, private-use U+E000 U+E001 (first version):
```
"The government has announced \uE000\uE001hier\uE000\uE001 new \uE000\uE001measures\uE000\uE001 to support small businesses."
"According to the minister, these aids will be \uE000\uE001s$ \uE000\uE000\uE001 as of next month."
"The unions welcomed this \uE000\uE001decision\uE000\uE001, while demanding that employees be better protected."
```

Sample replies, numbered ⟦n⟧ (shipped):
```
"The government announced ⟦1⟧ yesterday ⟦2⟧ news ⟦3⟧ measures ⟦4⟧ to support small businesses."
"According to the minister, these aids will be ⟦1⟧ paid ⟦2⟧ as of next month."
"The unions welcomed this ⟦1⟧ decision ⟦2⟧ , while demanding that employees be better protected."
```

## es to en

Pack es>en v2.0, 37.0 MB. 8 sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).

| Candidate | Intact |
|---|---|
| private-use U+E000 U+E001 (first version) | 8/8 |
| private-use U+E000 alone | 8/8 |
| double bar ‖ | 6/8 |
| numbered ⟦n⟧ (shipped) | 8/8 |
| numbered [[n]] | 6/8 |
| numbered <n> | 6/8 |
| numbered {n} | 6/8 |
| slash-bar |/| | 7/8 |
| section sign § | 8/8 |

Shipped path (groupItems, engine, splitSegment): 8/8 segments cut back into nodes.

Sample replies, private-use U+E000 U+E001 (first version):
```
"The government announced \uE000\uE001Ayer\uE000\uE001 new \uE000\uE001measures\uE000\uE001 to support small businesses."
"According to the minister, these aids will be paid \uE000\uE001a from next month\uE000\uE001."
"Unions \uE000\uE000A welcomed the decision\uE000\uE001 \uE000\uE001 but call for more protection for workers."
```

Sample replies, numbered ⟦n⟧ (shipped):
```
"The government announced ⟦1⟧ yesterday ⟦2⟧ new ⟦3⟧ measures ⟦4⟧ to support small businesses."
"According to the minister, these aids will be paid ⟦1⟧ from next month ⟦2⟧ ."
"The unions ⟦1⟧ welcomed ⟦2⟧ the decision, but call for more protection for workers."
```

## de to en

Pack de>en v2.0, 37.3 MB. 8 sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).

| Candidate | Intact |
|---|---|
| private-use U+E000 U+E001 (first version) | 5/8 |
| private-use U+E000 alone | 7/8 |
| double bar ‖ | 6/8 |
| numbered ⟦n⟧ (shipped) | 8/8 |
| numbered [[n]] | 8/8 |
| numbered <n> | 8/8 |
| numbered {n} | 7/8 |
| slash-bar |/| | 6/8 |
| section sign § | 4/8 |

Shipped path (groupItems, engine, splitSegment): 8/8 segments cut back into nodes.

Sample replies, private-use U+E000 U+E001 (first version):
```
"The Government has \uE000\uE001esday\uE000\uE000\uE000\uE000\uE001 announced new \uE000\uE001\uE001 \uE000\uE001 measures to support small businesses."
"According to the Minister, these aids will be paid out \uE000\uE000\uE001 from next month\uE000\uE001."
"The trade unions welcomed the \uE000\uE000\uE001Decision\uE000\uE000\uE000, but called for better protection of workers."
```

Sample replies, numbered ⟦n⟧ (shipped):
```
"The government announced ⟦1⟧ yesterday ⟦2⟧ new ⟦3⟧ measures ⟦4⟧ to support small businesses."
"According to the Minister, these aids will be ⟦1⟧ paid out from next month ⟦2⟧."
"The unions welcomed the ⟦1⟧ decision ⟦2⟧ , but called for better protection of workers."
```

## en to ar

Pack en>ar v2.2, 35.6 MB. 8 sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).

| Candidate | Intact |
|---|---|
| private-use U+E000 U+E001 (first version) | 0/8 |
| private-use U+E000 alone | 1/8 |
| double bar ‖ | 3/8 |
| numbered ⟦n⟧ (shipped) | 7/8 |
| numbered [[n]] | 7/8 |
| numbered <n> | 5/8 |
| numbered {n} | 6/8 |
| slash-bar |/| | 2/8 |
| section sign § | 4/8 |

Shipped path (groupItems, engine, splitSegment): 6/8 segments cut back into nodes.

Sample replies, private-use U+E000 U+E001 (first version):
```
"أعلنت الحكومة \uE000الآسب\uE000\uE000\uE001 جديد\uE000القياسات\uE000الدعم للشركات الصغيرة."
"ووفقا للوزير، فإن هذه المساعدات ستكون \uE000\uE000الدفع\uE001) من الشهر المقبل."
"رحبت النقابات بـ \uE000\uE000القرار\uE000\uE001, بينما طلب حماية أفضل للعمال."
```

Sample replies, numbered ⟦n⟧ (shipped):
```
"أعلنت الحكومة ⟦1⟧ أمس ⟦2⟧ ⟦3⟧ جديد ⟦3⟧ التدابير ⟦4⟧ لدعم الشركات الصغيرة."
"ووفقا للوزير، سيتم دفع هذه المساعدات ⟦1⟧⟦2⟧ من الشهر المقبل."
"ورحبت النقابات بالقرار ⟦1⟧⟦2⟧، بينما طلبت حماية أفضل للعمال."
```

Refused by splitSegment:
```
"The government announced ⟦1⟧ yesterday ⟦2⟧ new ⟦3⟧ measures ⟦4⟧ to support small businesses."
  -> "أعلنت الحكومة ⟦1⟧ أمس ⟦2⟧ ⟦3⟧ جديد ⟦3⟧ التدابير ⟦4⟧ لدعم الشركات الصغيرة."
"The city of ⟦1⟧ London ⟦2⟧ will host a big music festival this summer."
  -> "ستستضيف مدينة لندن ⟦2⟧ مهرجانًا موسيقيًا كبيرًا هذا الصيف."
```

## en to fa

Pack en>fa v1.1, 21.6 MB. 8 sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).

| Candidate | Intact |
|---|---|
| private-use U+E000 U+E001 (first version) | 0/8 |
| private-use U+E000 alone | 3/8 |
| double bar ‖ | 2/8 |
| numbered ⟦n⟧ (shipped) | 0/8 |
| numbered [[n]] | 5/8 |
| numbered <n> | 7/8 |
| numbered {n} | 5/8 |
| slash-bar |/| | 1/8 |
| section sign § | 3/8 |

Shipped path (groupItems, engine, splitSegment): 0/8 segments cut back into nodes.

Sample replies, private-use U+E000 U+E001 (first version):
```
"دولت اعلام کرد \uE000\uE000\uE000'\uE000'\uE000'\uE000'برای حمایت از کسب و کارهای کوچک است."
"به گفته وزیر، این کمک ها از ماه آینده \uE000\uE000\uE000\uE001 خواهد بود."
"اتحادیه ها از این \uE000\uE000\uE000\uE000\uE023\uE001\uE001\uE001 ، در حالی که درخواست حفاظت بهتر از کارگران می کنند، استقبال می کنند."
```

Sample replies, numbered ⟦n⟧ (shipped):
```
"دولت روز گذشته ۱⟧ اعلام کرد ⟦⟧ ⟦⟧ اقدامات جدید ⟦۴⟧ برای حمایت از کسب و کارهای کوچک ۱⟦⟧ است."
"به گفته وزیر، این کمک ها از ماه آینده ۱⟦⟧ پرداخت خواهد شد ۱⟦⟧ ⟦⟧ پرداخت خواهد شد."
"اتحادیه ها از این تصمیم ۱⟦⟧ ⟦ۧ استقبال کردند، در حالی که درخواست حفاظت بهتر از کارگران را داشتند."
```

Refused by splitSegment:
```
"The government announced ⟦1⟧ yesterday ⟦2⟧ new ⟦3⟧ measures ⟦4⟧ to support small businesses."
  -> "دولت روز گذشته ۱⟧ اعلام کرد ⟦⟧ ⟦⟧ اقدامات جدید ⟦۴⟧ برای حمایت از کسب و کارهای کوچک ۱⟦⟧ است."
"According to the minister, this aid will be ⟦1⟧ paid ⟦2⟧ from next month."
  -> "به گفته وزیر، این کمک ها از ماه آینده ۱⟦⟧ پرداخت خواهد شد ۱⟦⟧ ⟦⟧ پرداخت خواهد شد."
"The unions welcomed the ⟦1⟧ decision ⟦2⟧ , while asking for better protection for workers."
  -> "اتحادیه ها از این تصمیم ۱⟦⟧ ⟦ۧ استقبال کردند، در حالی که درخواست حفاظت بهتر از کارگران را داشتند."
"The city of ⟦1⟧ London ⟦2⟧ will host a big music festival this summer."
  -> "شهر ۱⟦⟧ لندن ۲⟧ تابستان امسال میزبان یک جشنواره بزرگ موسیقی خواهد بود."
"Click ⟦1⟧ here ⟦2⟧ to ⟦3⟧ read more ⟦4⟧ about this article."
  -> "اینجا را کلیک کنید ⟦1⟧ ⟦⟧ به ⟦⟧ بیشتر بخوانید ⟦4⟧ در مورد این مقاله."
"Posted ⟦1⟧ 5 ⟦2⟧ days ago by ⟦3⟧ Anna ⟦4⟧ ."
  -> "ارسال شده ⟦1⟧ 5 ⟦2⟧ روز پیش توسط ⟦⟧ آنا ⟦4⟧."
"Showing ⟦1⟧ 10 ⟦2⟧ of ⟦3⟧ 200 ⟦4⟧ results"
  -> "نمایش ⟦1⟧ 10 ⟦2⟧ از ⟦3⟧ 200 ⟦⟧ نتایج"
"The new museum will open its doors to the public on the first day of ⟦1⟧ spring ⟦2⟧ ."
  -> "این موزه جدید درهای خود را در اولین روز از بهار ۱⟦⟧ به روی عموم باز خواهد کرد ۲⟧."
```

## ja to en

Pack ja>en v2.1, 54.8 MB. 8 sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).

| Candidate | Intact |
|---|---|
| private-use U+E000 U+E001 (first version) | 1/8 |
| private-use U+E000 alone | 0/8 |
| double bar ‖ | 4/8 |
| numbered ⟦n⟧ (shipped) | 5/8 |
| numbered [[n]] | 5/8 |
| numbered <n> | 5/8 |
| numbered {n} | 3/8 |
| slash-bar |/| | 1/8 |
| section sign § | 3/8 |

Shipped path (groupItems, engine, splitSegment): 5/8 segments cut back into nodes.

Sample replies, private-use U+E000 U+E001 (first version):
```
"The government announced yesterday \uE000\uE001 a new measure to support small and medium-sized enterprises."
"According to the Minister, this support will be paid from next month."
"The trade union welcomed this decision, but is calling for better protection of the workers."
```

Sample replies, numbered ⟦n⟧ (shipped):
```
"The government announced new measures to support small and medium-sized enterprises ⟦1⟧ yesterday ⟦2⟧ ."
"According to the minister, this support will be paid from ⟦1⟧ next month ⟦2⟧ ."
"The trade union welcomed this ⟦1⟧ decision ⟦2⟧ but called for better protection of the workers."
```

Refused by splitSegment:
```
"政府は ⟦1⟧ 昨日 ⟦2⟧ 、中小企業を支援するための ⟦3⟧ 新しい対策 ⟦4⟧ を発表しました。"
  -> "The government announced new measures to support small and medium-sized enterprises ⟦1⟧ yesterday ⟦2⟧ ."
"詳しくは ⟦1⟧ こちら ⟦2⟧ をクリックして ⟦3⟧ 記事を読む ⟦4⟧ ことができます。"
  -> "For more information, click here ⟦2⟧ ⟦3⟧ Read the article ⟦4⟧ ."
"200 ⟦1⟧ 件中 ⟦2⟧ 10 ⟦3⟧ 件を表示"
  -> "200 ⟦1⟧ Showing 2⟧ 10 ⟦3⟧"
```

## Summary

| Pair | private-use U+E000 U+E001 (first version) | private-use U+E000 alone | double bar ‖ | numbered ⟦n⟧ (shipped) | numbered [[n]] | numbered <n> | numbered {n} | slash-bar |/| | section sign § | shipped path |
|---|---|---|---|---|---|---|---|---|---|---|
| fr>en | 6/8 | 3/8 | 5/8 | 8/8 | 7/8 | 7/8 | 5/8 | 7/8 | 5/8 | 8/8 |
| es>en | 8/8 | 8/8 | 6/8 | 8/8 | 6/8 | 6/8 | 6/8 | 7/8 | 8/8 | 8/8 |
| de>en | 5/8 | 7/8 | 6/8 | 8/8 | 8/8 | 8/8 | 7/8 | 6/8 | 4/8 | 8/8 |
| en>ar | 0/8 | 1/8 | 3/8 | 7/8 | 7/8 | 5/8 | 6/8 | 2/8 | 4/8 | 6/8 |
| en>fa | 0/8 | 3/8 | 2/8 | 0/8 | 5/8 | 7/8 | 5/8 | 1/8 | 3/8 | 0/8 |
| ja>en | 1/8 | 0/8 | 4/8 | 5/8 | 5/8 | 5/8 | 3/8 | 1/8 | 3/8 | 5/8 |

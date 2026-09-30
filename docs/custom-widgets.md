# Custom widgets

A custom widget is a **recipe**: a few lines of JSON that name one web address answering JSON, and what to show from it. Paste one into **Settings → Appearance → New tab page → Widgets → Add a widget → Custom**, press **Test**, then **Add to page**. Recipes are plain text, so you can share them in a chat or a gist.

A recipe can't run code. Lumen fetches the address itself (https only, without your cookies, at most every 5 minutes) and puts only the text it picks out on the card.

## Numbers or words: `"view": "stats"`

```json
{
  "name": "Dollar rates",
  "url": "https://open.er-api.com/v6/latest/USD",
  "every": 720,
  "view": "stats",
  "stats": [
    { "label": "EUR", "path": "rates.EUR", "decimals": 3, "prefix": "€" },
    { "label": "GBP", "path": "rates.GBP", "decimals": 3, "prefix": "£" }
  ]
}
```

Each stat is `{ "label", "path", "prefix"?, "suffix"?, "decimals"? }`, and a card shows up to 6 of them.

## A list: `"view": "list"`

```json
{
  "name": "Hacker News",
  "url": "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10",
  "every": 15,
  "view": "list",
  "list": { "path": "hits", "title": "title", "detail": "points", "link": "url", "max": 8 }
}
```

- `list.path` points to the array in the answer. Leave it empty when the answer itself is the array.
- `title`, `detail` and `link` are paths inside each item. Only `title` is required. Links must be https. Any other link is dropped.
- `max` is 1 to 20 (default 8).

## Paths

A path is a list of names separated by dots, with `[n]` for the nth element of an array. For example, `data.items[0].price` means answer → `data` → `items` → first element → `price`. To find the names, open the address in a tab and look at the JSON. Numbers are formatted for reading (`1,234.5`), `true` or `false` shows as Yes or No, and a value that isn't found shows as `–`.

## All fields

| Field | What it is | Default |
| --- | --- | --- |
| `name` | The card's title | the address's host |
| `url` | An https address that answers JSON | required |
| `every` | Minutes between refreshes, 5 to 1440 | 30 |
| `view` | `"stats"` or `"list"` | `stats` when there are stats |
| `stats` | Up to 6 `{ label, path, prefix, suffix, decimals }` | |
| `list` | `{ path, title, detail, link, max }` | |

## Limits

- The address has to work without signing in. Recipes have no place for API keys, because a shared recipe would share the key. A key placed in the URL is saved in Lumen's settings file as plain text.
- Answers bigger than 2 MB are cut off, and all widgets together make at most 40 requests a minute.
- For a whole web page rather than values from it, use the **Web page** widget.

The code is in `features/custom-widget.js`, and the tests are in `test/local-custom-units.js`.

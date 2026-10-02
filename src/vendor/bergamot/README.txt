Bergamot translator, the engine behind Firefox Translations (Mozilla, MPL-2.0).

bergamot-translator.wasm   bergamot-translator v0.6.0 (wasm "3.0" in Mozilla's `translations-wasm`
                           Remote Settings collection), revision 1de4a085d3a7afb625c51a60aabb5ad298e4059f.
                           SHA-256 a3a89d9ad0a4ed8f27bf3e403701b23f5709816f6376438503f2fa5b0182c2dc
                           (the hash Mozilla publishes for this attachment). Unmodified.
bergamot-translator.js     The Emscripten loader for that exact build ("v0.6.0+1de4a085d"), copied unmodified
                           from mozilla-firefox/firefox, toolkit/components/translations/bergamot-translator/,
                           commit 2c8de06aca (the commit that shipped this build).
LICENSE                    MPL-2.0.

Language models are NOT bundled. They are downloaded on demand from Mozilla's Remote Settings
(`translations-models`, MPL-2.0) and checked against the SHA-256 hashes that registry publishes.
See src/features/translate-models.js.

To update: pick a newer record from
https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm/records,
take the loader from the Firefox commit that added it, and keep the model major version range in
translate-models.js compatible (see TranslationsParent.sys.mjs in Firefox).

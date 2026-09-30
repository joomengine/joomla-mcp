# Native companion runtime regression parity

The shared native defects reported in PHP component issues #7–#10 are tracked
in [joomla-mcp #44](https://github.com/joomengine/joomla-mcp/issues/44) and
[component PR #16](https://github.com/joomengine/mcp_component/pull/16).

| Contract | Shared native correction |
| --- | --- |
| Object-valued inputs | Preserve JSON objects until validation; accept `{}` and reject `[]`, null and scalar inputs. Preserve nested object/list values. |
| Discovery schemas | Serialize empty `properties` as `{}`. JavaScript MCP object defaults already use `{}` and have an explicit serialized regression assertion. |
| List pages | Preserve exact zero-based offsets, empty pages at/beyond total, and partial final slices despite Joomla ListModel's native last-page clamp. Count the full cache group collection before slicing. |
| Content languages | Resolve the public `id` alias to the native `lang_id` field and select qualified fields only when the native model approves them. |
| Native item read-back | Preserve actual output objects and restore stored JSON mappings/lists from the selected native item table when Joomla converts Registry objects to arrays. Limit recovery to existing readable Registry fields and matching record IDs; list pages perform no per-row table reads. |

Independent Joomla 6.1.3 reproduction confirmed that a one-category model
rewinds requested offset 1 to native start 0, and that content-language ordering
by `id` fails while ordering by `lang_id` succeeds on a fresh single-language
installation. The regression suite covers all 13 list actions identified by the
component report, fresh/reused models, zero/one/multiple rows, partial/end
boundaries, cache totals, schema serialization and malformed inputs.

Joomla's Article model converts metadata, attributes and images from Registry
objects to PHP arrays before returning an item. Native single-item reads and
saved read-back recover the stored JSON shapes for the already-readable fixed
Registry fields (`params`, `fieldparams`, `metadata`, `attribs`, `images`, `urls`).
Recovery requires the stored content to equal the model-visible content, with
strict scalar types, so native redactions and transformations remain effective.
Malformed, oversized or unavailable stored evidence retains the native result;
strict write verification continues to distinguish `{}` from `[]`.

The PHP component's encrypted-session response persistence, retained SDK schema
cache, and wire error classification use a different transport/runtime. Those
findings are not transferred to the Node SDK without an independent reproduction.
This change does not add JCB capabilities to the TypeScript server.

Run `php companion/tests/run.php` for the native companion contracts and
`npm run validate` for the TypeScript, HTTP and packaging checks.

Live extension-state acceptance selects a disabled, unprotected optional plugin
from explicit plugin pages instead of the first unfiltered page. The selected
identity and original state are retained for restoration; critical plugin
folders and ambiguous/protected flags are excluded. Selector regressions cover
later pages, bounded searches, exclusions, restoration identity and read failures.

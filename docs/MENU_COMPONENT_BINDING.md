# Menu component binding through the API

`menus.site-items.create/update` and `menus.administrator-items.create/update`
now persist Joomla's native `component_id` and verify the stored value. This fixes
[#39](https://github.com/joomengine/joomla-mcp/issues/39), where a created menu
could display “Component does not exist” in the administrator while a single-item
API read appeared correct.

Joomla's menu `ItemModel::getItem()` derives a component ID from the link, but
`save()` does not perform that derivation. The item getter can therefore mask a
stored zero or an outdated component ID. The collection response reads the stored
value and is the verification authority.

## Approved native execution

API menu plans require both `structure.write` and `structure.read`, including the
corresponding remote MCP scopes. Joomla still checks its API login and menu ACL.
Dry runs read and prepare metadata but perform no mutations.

The plan freezes the effective menu client, menu type identifier (`menutype`),
item type, link and form body. Partial updates read their current native form
context during planning. The preview and confirmation explicitly include the
following bounded workflow:

1. Apply the requested POST or PATCH with an internal `component_id` of zero.
   Clearing it first prevents an unavailable replacement component from retaining
   an old positive ID during Joomla's item read.
2. For a component menu, read the exact resulting item and check its ID, client,
   item type, menu type identifier and complete link against the approved plan.
   Accept only Joomla's positive derived component ID.
3. Perform one corrective PATCH using the approved form body and that derived
   ID. Use a fresh ETag from the item read when available, and a deterministic
   repair UUID distinct from the primary idempotency key.
4. Read the stored menu collection, narrowed by the approved `menutype`, and
   verify the target item and `component_id`. Non-component menu items remain
   at zero and skip the corrective PATCH.

No caller-selectable `component_id`, route, component lookup or arbitrary repair
request is added. Duplicate or array-shaped `option` parameters are rejected
before mutation. All reads use fixed catalogue routes and numeric pagination;
response-provided next URLs are never followed. Verification stops after 100
pages or 10,000 items.

## Outcomes and recovery

Apply returns an explicit `outcome`:

| Outcome | Meaning |
|---|---|
| `verified` | The stored collection matches the approved menu binding. |
| `partial` | Joomla acknowledged the primary mutation, but a later step failed or persistence could not be verified. The response retains the mutation and item ID when available. |
| `uncertain` | The primary request failed without a conclusive response. Joomla may already have processed it. |

Partial and uncertain results are retained in the same principal-bound
idempotency cache as successful writes. Replanning with the same key cannot repeat
the original POST; a changed operation with that key is rejected. The existing
TypeScript cache is process-local and expires after 24 hours. Inspect the menu
before using a different key, after restarting the server, or after expiry.

An accepted write followed by a failed read is never reported as a verified
success. Joomla's native collection omits trashed menu items; a write that trashes
an item consequently reports an unverified partial outcome. Check the native
administrator and retain the returned item ID for recovery. Do not repeat a
create merely because the corrective PATCH or readback failed.

The local companion transport retains its existing native implementation. This
API correction does not add an extra companion command or a generic model route.

## Testing and authority

Offline tests reproduce the distinction between a derived item getter and a
stored collection. They cover both menu clients, cross-component links,
non-component transitions, read-scope denial, malformed derived IDs, fixed
pagination, identity mismatches, and replay after partial or uncertain results.

On a disposable Joomla site, create a component menu, update it to a different
installed component, and inspect the collection's stored ID and the native
administrator. Verify a title-only update repairs an existing zero. Exercise a
failed corrective PATCH and confirm that the same-key retry cannot create a
second item. Cleanup the test menus after retaining any failure evidence.

Source contracts reviewed in Joomla `6.1-dev` and `6.2-dev`:

- [Administrator menu ItemModel](https://github.com/joomla/joomla-cms/blob/6.1-dev/administrator/components/com_menus/src/Model/ItemModel.php): native item derivation and save lifecycle.
- [Administrator menu ItemsModel](https://github.com/joomla/joomla-cms/blob/6.1-dev/administrator/components/com_menus/src/Model/ItemsModel.php): stored collection and visibility rules.
- [API menu ItemsController](https://github.com/joomla/joomla-cms/blob/6.1-dev/api/components/com_menus/src/Controller/ItemsController.php): client and menu-type filters.
- [API menu JSON view](https://github.com/joomla/joomla-cms/blob/6.1-dev/api/components/com_menus/src/View/Items/JsonapiView.php): item and collection fields.

Offline tests are not a substitute for the live Joomla success, ACL, recovery and
cleanup matrix described in [CONTRIBUTING.md](../CONTRIBUTING.md).

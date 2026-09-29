# Writing custom field values

API create and update plans accept the names of published custom fields from the
selected Joomla site. This applies to `content.articles`, `content.categories`,
`contacts.contacts` and `users.users`, and to the typed
`joomla_content_article_create_plan` and `joomla_content_article_update_plan` tools.

Enable `structure.read` alongside the action's write toolset, and give the Joomla
API identity permission to read the corresponding field definitions. Remote MCP
principals also need that read scope. Existing core-field-only plans do not need
field discovery. Use `joomla_action_describe` for the selected action and site to
inspect resolved custom field names and their Joomla types.

## Article example

On the site and article from issue #38, a generic dry run is:

```json
{
  "action": "content.articles.update",
  "transport": "api",
  "dryRun": true,
  "idempotencyKey": "3f38a5e5-6ff1-4aad-90e4-ff9389973928",
  "input": {
    "id": 9,
    "data": {
      "teamleden": "{\"row0\":{\"field1\":\"Sample team member\"}}"
    }
  }
}
```

The example requires the existing `teamleden` field and article `9`. The nested
subform keys must match that field's real configuration; discover those settings
and use the native value shape accepted by its Joomla field plugin. The adapter
does not invent, convert or double-encode custom field values.

The equivalent alias is `"data": {"com_fields": {"teamleden": "..."}}`.
Supplying the same field both at the top level and inside `com_fields` is rejected.
Core form keys cannot be smuggled through the alias.
Custom field `null` values are rejected because Joomla's top-level preprocessing
skips them; use an empty string or empty array when that field type supports
clearing a value.

For a real write, obtain the normal operator grant, omit `dryRun`, use a fresh
idempotency UUID, review the returned plan, then call `joomla_write_apply` with its
confirmation token. Planning and applying remain separate. A dry run performs
field reads but no mutation.

## Validation and transport contract

Only matching published definitions in the expected context are accepted;
unpublished field groups and unknown names are excluded. Discovery uses bounded
pages from fixed catalogue routes. A failed or incomplete lookup fails closed.
Prototype keys and core-field collisions are rejected, and the normal JSON/body
limits remain enforced. Each plan binds resolved field metadata and normalized
values so a later field-list change cannot introduce extra approved keys.

| Resource | Joomla field context | API body sent |
|---|---|---|
| Articles | `com_content.article` | Custom field names at the top level |
| Content categories | `com_content.categories` | Custom values inside `com_fields` |
| Contacts | `com_contact.contact` | Custom field names at the top level |
| Users | `com_users.user` | Custom field names at the top level |

Joomla remains responsible for per-item applicability, category/language/access
restrictions, field-value validation, ACL, plugin events and persistence. Stock
Joomla 6.1/6.2 field-list and field-detail API output does not expose
`only_use_in_subform`; a field listed there is not proof that it can be saved as a
standalone item field. Verify persistence using Joomla readback and the native
editor, particularly for subforms. Live site testing remains necessary.

This addition supports the API transport. The local companion does not gain
custom-field write support in this change. Select `transport: "api"` when using
the generic tool on a site with both adapters.

## Acceptance testing

Use a disposable site or test content and retain original values for cleanup.

1. Describe article create/update actions and confirm the expected published
   field names/types. Check that another site's fields do not appear.
2. Dry-run a text value and the site's actual repeatable/subform value through
   both generic and typed article tools. Confirm an unknown name, unpublished
   field, wrong-context field and duplicate alias are rejected before mutation.
3. Create a test article with values, then update only a custom field. Apply the
   approved plans and inspect values in the article API and Joomla editor.
   Confirm omitted article text and unrelated fields remain unchanged.
4. Repeat an update with the `com_fields` alias and compare the saved result.
5. Check denial without field-read authorization; then restore it and re-plan.
   No mutation should occur from a failed plan.
6. Test category, contact and user contexts where the site uses them; check the
   category's nested payload and native form validation. Remove test content and
   restore any changed field settings afterward.

Report the Joomla version, MCP commit, action/transport, field type and redacted
input/result on [issue #38](https://github.com/joomengine/joomla-mcp/issues/38).
Never include API tokens, confirmation tokens or private content.

## Joomla source authority

The following contracts were reviewed on `6.1-dev` and `6.2-dev`:

- `api/components/com_content/src/Controller/ArticlesController.php`
- `api/components/com_contact/src/Controller/ContactController.php`
- `api/components/com_users/src/Controller/UsersController.php`
- `api/components/com_categories/src/Controller/CategoriesController.php`
- `api/components/com_fields/src/Controller/FieldsController.php`
- `api/components/com_fields/src/View/Fields/JsonapiView.php`
- `libraries/src/MVC/Controller/ApiController.php`
- `plugins/system/fields/src/Extension/Fields.php`

These files are in [Joomla core](https://github.com/joomla/joomla-cms).

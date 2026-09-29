# Template style creation

`templates.site-styles.create` and `templates.administrator-styles.create` create
styles for an already installed template. Supply `template`, `title`, and the
ordinary optional `home`/`params` fields. Install the template through Joomla
first; the adapter refuses to create a style if no existing style of that exact
template and client can be read.

The adapter reads Joomla's installed manifest through the existing style. It
derives the hidden `parent` and `inheritable` form fields, includes them in the
confirmation fingerprint and displayed preflight, and passes them to the native
save. A child such as a Cassiopeia child therefore retains its parent asset
registry. Absent or empty manifest elements have Joomla's installer defaults:
empty parent and `inheritable=0`. Parent templates retain `inheritable=1`.
Callers cannot set either hidden field directly.

API metadata reads require `structure.read` as well as the existing controlled
`structure.write` flow. Joomla's token still needs native API login and template
management/create permissions. A dry run only reads metadata. Apply rechecks
metadata and refuses a change since confirmation; request a fresh plan after
installing or changing the template. Native companion plans expose the same
derived metadata and the existing preflight comparison rejects changed values.

Reads stay on the selected site/client and are bounded to ten collection pages,
at most 100 rows per page (or the configured smaller API page size), and twenty
matching styles. All matching manifests must agree. Missing manifests, invalid
values, conflicting records, wrong-client records, duplicate pagination rows,
or exceeding a bound stop before creating a style. No parent is guessed from
the template name or copied from a different template.

## Joomla authority and validation

Reviewed Joomla 6.1 and 6.2 sources:

- `api/components/com_templates/src/View/Styles/JsonapiView.php`: list includes
  `template` and `client_id`; item includes the parsed manifest as `xml`.
- `administrator/components/com_templates/src/Model/StyleModel.php`: `getItem`
  reads the installed template's `templateDetails.xml` for that client; `save`
  uses Joomla's normal table/events lifecycle.
- `administrator/components/com_templates/forms/style.xml`: hidden `parent`
  and `inheritable` form fields.
- `libraries/src/Installer/Adapter/TemplateAdapter.php`: installation derives
  these fields from the native manifest.

Offline API and native companion tests cover inherited, standalone, and parent
templates, both clients, non-mutating previews, permission denial, invalid
metadata, pagination limits, and metadata changes after approval. These tests
do not claim that a live Joomla page was rendered. To test the reported issue on
a disposable site, install a child template, create a style through MCP, assign
it to a test page, and confirm the page renders without the missing parent asset
error. Then unassign and delete the test style; retain the original installed
style so the template remains usable. Repeat with an ordinary parent template
and, where installed, an administrator child template.

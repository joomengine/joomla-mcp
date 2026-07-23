# Joomla 6.x reconnaissance

Examined on 22 July 2026 using Joomla source as the authority and the Manual as supporting documentation.

## Branches

| Branch | Examined head | Role |
|---|---|---|
| `6.1-dev` | [`071afb7`](https://github.com/joomla/joomla-cms/tree/071afb7ad305c02983a653ccfc301b5c8360264b) | Implementation baseline |
| `6.2-dev` | [`df0e57d`](https://github.com/joomla/joomla-cms/tree/df0e57da1cf3febfd8d4da0c522b87f3d5c6aec5) | Forward compatibility |
| `7.0-dev` | [`b3a08ce`](https://github.com/joomla/joomla-cms/tree/b3a08ce4cbca0c77ff34c9b1abe1c431536dbb3f) | Canary only |

The Web Services route registrations and installed-site command names are effectively unchanged across these heads. Joomla 7 has active API and ACL refactoring and removes deprecated application-property access, so integration code must use getters and dependency injection.

## CLI path

The installed-site entry point [`cli/joomla.php`](https://github.com/joomla/joomla-cms/blob/071afb7ad305c02983a653ccfc301b5c8360264b/cli/joomla.php) requires PHP 8.3, loads Joomla's framework and DI container, aliases CLI session services, obtains `Joomla\Console\Application`, and executes it.

Core commands are assembled from eager defaults in [`ConsoleApplication`](https://github.com/joomla/joomla-cms/blob/071afb7ad305c02983a653ccfc301b5c8360264b/libraries/src/Application/ConsoleApplication.php) and lazy service mappings in the [`Application` provider](https://github.com/joomla/joomla-cms/blob/071afb7ad305c02983a653ccfc301b5c8360264b/libraries/src/Service/Provider/Application.php). Enabled console plugins can add or shadow commands during `ApplicationEvents::BEFORE_EXECUTE`.

### Installed-site command inventory

- Framework: `list`, `help`.
- Cache/config/site: `cache:clean`, `config:get`, `config:set`, `site:down`, `site:up`, `site:create-public-folder`.
- Core/update/extensions: `core:autoupdate:register`, `core:autoupdate:unregister`, `core:update`, `core:update:check`, `core:update:channel`, `update:extensions:check`, `update:joomla:remove-old-files`, `extension:list`, `extension:enable`, `extension:disable`, `extension:remove`, `extension:install`, `extension:discover`, `extension:discover:list`, `extension:discover:install`.
- Users: `user:list`, `user:add`, `user:addtogroup`, `user:removefromgroup`, `user:reset-password`, `user:delete`.
- Scheduler/search/maintenance/session: `scheduler:list`, `scheduler:run`, `scheduler:state`, `finder:index`, `maintenance:database`, `session:gc`, `session:metadata:gc`.
- Database: `database:export`, `database:import`.

Fresh installation through `installation/joomla.php install` is a separate provisioning concern.

### CLI conclusions

- Output is human-oriented Symfony console output, not a stable JSON contract.
- CLI has no API-token ACL boundary; MCP policy must authorize every operation.
- `config:get` can disclose database and SMTP credentials and must never be exposed raw.
- `--no-interaction` skips confirmation in high-risk commands; it is automation behavior, not approval.
- Password arguments leak through process lists; the PHP bridge must accept secrets over stdin.
- URL extension installation is code execution and an SSRF surface.
- Database import drops tables before recreation.
- Run under a dedicated site deployment account, never root.

## API path

Routes are registered by enabled plugins under [`plugins/webservices`](https://github.com/joomla/joomla-cms/tree/6.1-dev/plugins/webservices). [`ApiRouter::createCRUDRoutes`](https://github.com/joomla/joomla-cms/blob/6.1-dev/libraries/src/Router/ApiRouter.php) expands each base into list, get, create, patch, and delete routes.

Core currently declares 36 CRUD bases, producing 180 generic routes, plus 46 static special routes and 10 dynamic language-override routes per configured content language.

### CRUD bases by domain

| Domain | Base paths |
|---|---|
| Content | `v1/content/articles`, `v1/content/categories` |
| Banners | `v1/banners`, `v1/banners/clients`, `v1/banners/categories` |
| Contacts | `v1/contacts`, `v1/contacts/categories` |
| Menus | `v1/menus/site`, `v1/menus/administrator`, site/admin item routes |
| Modules | `v1/modules/site`, `v1/modules/administrator` |
| Users | `v1/users`, `v1/users/groups`, `v1/users/levels` |
| Tags/templates/languages/messages | Tags, site/admin template styles, content languages, messages |
| Newsfeeds/redirects | `v1/newsfeeds/feeds`, `v1/newsfeeds/categories`, `v1/redirects` |
| Fields | Content, contact, and user field and field-group contexts |

Special routes cover contact submission, menu/module types, plugin state, media, configuration, installed extensions, privacy, language packages/overrides, limited content history, and Joomla Update.

### API contract

- URL: `https://site.example/api/index.php/v1/...`.
- Authentication: `Authorization: Bearer TOKEN` or `X-Joomla-Token`; bearer form is used here.
- Normal API users require `core.login.api` plus component ACL.
- Responses use JSON:API-style resources.
- POST/PATCH bodies are flat Joomla form JSON, not a JSON:API `data.attributes` envelope.
- Default pagination is `page[offset]=0&page[limit]=20`; core has no clear generic maximum, so MCP imposes one.
- There is no OpenAPI, route-discovery, or capability endpoint.
- Joomla Update is separate: it uses `X-JUpdate-Token` and Auto Update configuration, not the normal API token.

### Corrections to the supplied action inventory

- There is no standalone Web Services - Fields plugin; Content, Contact, and Users plugins register those routes.
- Content history is limited to articles, contacts, and banners, and its keep/delete ID semantics need contract tests.
- Contact-form submission still requires API authentication.
- Language-override routes are dynamically generated per content language.
- `GET v1/extensions` only lists extensions; it cannot install, update, remove, discover, or repair them.
- Plugin patching accepts only a narrow field set.
- Media identifiers are greedy paths, not numeric IDs.
- Delete lifecycle is model-specific; trash-first is not universal.
- Messages and template styles are direct-delete exceptions, with additional model rules.
- Joomla Update needs its own credential and separately enabled high-risk toolset.

## Integration decisions derived from core

The implementation uses the Web Services route when core provides the needed
remote operation. A local semantic action is added only when structured output,
stdin-only secret handling, an effective actor ACL check, or a missing remote
administration capability requires it.

The companion must call native Joomla services or fixed administrator models;
it must not reproduce their domain behavior. Stock CLI commands are not exposed
through a generic executor. Each accepted local operation needs a named schema,
fixed native target, explicit permission and risk, bounded result, postcondition,
and recovery contract. Arbitrary shell, PHP, SQL, filesystem paths, Joomla roots,
models, methods, commands, or outbound URLs remain outside the architecture.

See [Architecture](ARCHITECTURE.md) for the decision rules and
[Coverage](COVERAGE.md) for the implemented and verified status of each family.

# Writing article text

The `content.articles.create` and `content.articles.update` actions accept either
combined `articletext` or the native `introtext` and `fulltext` fields. This also
applies to `joomla_content_article_create_plan` and
`joomla_content_article_update_plan`.

For the generic `joomla_action_write_plan` tool, a complete body replacement is:

```json
{
  "action": "content.articles.update",
  "input": {
    "id": 42,
    "data": {
      "articletext": "<p>New introduction.</p><hr id=\"system-readmore\" /><p>New full text.</p>"
    }
  },
  "idempotencyKey": "17eec763-7c71-4f75-86a4-0df1eab040b2"
}
```

Use the actual article ID and a fresh UUID for each operation. The usual operator
permission, confirmation token, and `joomla_write_apply` flow still applies.

MCP converts the combined text before creating a confirmation plan and sends
native fields to the Joomla API or CLI companion:

```json
{
  "introtext": "<p>New introduction.</p>",
  "fulltext": "<p>New full text.</p>"
}
```

| Input | Behavior |
|---|---|
| `articletext` with a Joomla Read More marker | Split at the first matching marker; retain any later markers in full text. |
| `articletext` without a marker | Replace intro text and clear existing full text. |
| `articletext: ""` | Clear both parts. |
| Only `introtext` or only `fulltext` | Update that part; leave the omitted part unchanged. |
| No text fields, for example a title-only update | Leave both text parts unchanged. |
| `articletext` together with `introtext` or `fulltext` | Reject the ambiguous input before creating a plan, including when a value is empty. |

Marker recognition follows Joomla's `Content::bind()` expression: case-insensitive
`<hr id="system-readmore">`, with single or double quotes, whitespace after `hr`
and after the quoted ID, and an optional closing slash. Extra attributes, an
unquoted ID, or spaces around `=` are not Joomla Read More markers. The adapter
preserves text and whitespace; Joomla remains responsible for content filtering,
validation, ACL, events, and persistence.

## Why native fields are sent

Joomla's API controller fills omitted database columns from the current article
on PATCH. When it receives only `articletext`, existing `introtext` and `fulltext`
can overwrite the editor-text split during table binding. This produces a
successful response with unchanged article text, as reported in
[issue #31](https://github.com/joomengine/joomla-mcp/issues/31).

Sending both native fields for a combined-text replacement avoids that overwrite
without an additional read or Joomla core modification. Direct callers of the
Joomla REST endpoint must send native fields themselves; MCP's normalization
applies to writes made through this package.

The behavior was checked against the repository's pinned Joomla 6.1 and 6.2
sources (and its Joomla 7 canary):

- [API PATCH column completion, Joomla 6.1](https://github.com/joomla/joomla-cms/blob/071afb7ad305c02983a653ccfc301b5c8360264b/libraries/src/MVC/Controller/ApiController.php#L459-L470)
- [Article text binding, Joomla 6.1](https://github.com/joomla/joomla-cms/blob/071afb7ad305c02983a653ccfc301b5c8360264b/libraries/src/Table/Content.php#L148-L179)
- [Article form, Joomla 6.1](https://github.com/joomla/joomla-cms/blob/071afb7ad305c02983a653ccfc301b5c8360264b/administrator/components/com_content/forms/article.xml)
- [API PATCH column completion, Joomla 6.2](https://github.com/joomla/joomla-cms/blob/df0e57da1cf3febfd8d4da0c522b87f3d5c6aec5/libraries/src/MVC/Controller/ApiController.php#L459-L470)
- [Article text binding, Joomla 6.2](https://github.com/joomla/joomla-cms/blob/df0e57da1cf3febfd8d4da0c522b87f3d5c6aec5/libraries/src/Table/Content.php#L148-L179)

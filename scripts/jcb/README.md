# Refresh the JCB API catalogue

The Node server ships a catalogue generated from the official JCB 6.2.1 release
and its packaged webservices plugin. The source
revisions and the SHA-256 fingerprint of the 228 input files are recorded in
`generate-api-catalog.php`. The runtime reads only the bundled JSON.

The registration plugin supplies each HTTP method, path, identifier rule and
controller task. List controllers supply accepted filters and ordering keys.
For each writable resource the generator follows the item controller's edit
model and its explicit form binding. The form supplies field types, defaults,
read-only flags, input filters, validation rules, relationship keys, choices and
nested rows. The model supplies declared conditional requirements and native
GUID generation. The install schema supplies integer storage types for read-back
verification, including custom select fields. Joomla still applies the installed model, plugins and caller's
ACL to each request.

Nine packaged content plugins extend six edit forms. Their form registrations
and XML supply the default required radio selections on create, including the
Admin View privacy controls. These defaults appear in the catalogue separately
from writable fields. JCB's item serializers omit the underlying plugin params.

The Super Power repository selector builds its checkbox choices from published
Super Power repository definitions on the site. Its XML option is a hint,
and the field accepts multiple repository paths.

From a checkout of this repository, reproduce the catalogue with Git, curl,
tar, unzip and PHP 8.3+ with SimpleXML installed.

```bash
source_dir=$(mktemp -d)
git clone --quiet --branch v6.2.1 --depth 1 https://github.com/vdm-io/Joomla-Component-Builder.git "$source_dir/joomla"
package_revision=1aa00148cf4726a6eb0754d56250ea2411bc9951
curl -fsSL "https://github.com/joomengine/pkg-component-builder/archive/$package_revision.tar.gz" -o "$source_dir/package.tar.gz"
tar -xzf "$source_dir/package.tar.gz" -C "$source_dir"
package_src="$source_dir/pkg-component-builder-$package_revision/src"
for archive in "$package_src"/joomla__plg_content_componentbuilder*__6.x.zip "$package_src"/joomla__plg_webservices_componentbuilderapiroutes__6.x.zip; do
  unzip -q "$archive" -d "$source_dir/plugins"
done
php scripts/jcb/generate-api-catalog.php "$source_dir/joomla" "$source_dir/plugins"
git diff --exit-code -- src/jcb/api-catalog.json
npm test -- tests/jcb-api-catalog.test.ts
```

To adopt a new JCB revision, review changes to the registrations, controller
tasks, form bindings and model policies first. Update the two pinned revisions
and reviewed source fingerprint, regenerate the JSON, and run the catalogue
tests and installed JCB fixture. A changed source digest, unexpected route
parameter, unknown method/task pair or change in route counts stops generation.
The generated file is shared by discovery, request validation and dispatch.

The current sources register 320 routes across 51 writable families and two
list-only resources. The compiler and extrusion collections expose display
data. JCB's compiler command has a separate console contract.

The 6.2.0 release has the same registered requests, form field descriptors,
integer storage columns, plugin form registrations and default switches,
filters, ordering keys and 21 GUID-capable families as 6.2.1. Version 6.2.1
adds 40 explicit conditional-requirement groups in nine models. The bundled
descriptions include those groups. Both releases disable the language
translation source at creation. The comparison used the official
[6.2.0 component](https://github.com/vdm-io/Joomla-Component-Builder/tree/bb9b155f00c4ffd6de285de6fab9db4fec538ee8)
and [6.2.0 package](https://github.com/joomengine/pkg-component-builder/tree/c39005da5eec7011847831618dbb9cb11dba73b4).

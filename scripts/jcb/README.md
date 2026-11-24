# Refresh the JCB API catalogue

The Node server ships a catalogue generated from the official JCB 6.2.1 release
and its packaged webservices plugin. The source
revisions and the SHA-256 fingerprint of the 207 input files are recorded in
`generate-api-catalog.php`. The runtime reads only the bundled JSON.

The registration plugin supplies each HTTP method, path, identifier rule and
controller task. List controllers supply accepted filters and ordering keys.
For each writable resource the generator follows the item controller's edit
model and its explicit form binding. The form supplies field types, defaults,
read-only flags, input filters, validation rules, relationship keys, choices and
nested rows. The model supplies declared conditional requirements and native
GUID generation. Joomla still applies the installed model, plugins and caller's
ACL to each request.

From a checkout of this repository, reproduce the catalogue with Git, curl,
unzip and PHP 8.3+ with SimpleXML installed.

```bash
source_dir=$(mktemp -d)
git clone --quiet --branch v6.2.1 --depth 1 https://github.com/vdm-io/Joomla-Component-Builder.git "$source_dir/joomla"
curl -fsSL https://raw.githubusercontent.com/joomengine/pkg-component-builder/1aa00148cf4726a6eb0754d56250ea2411bc9951/src/joomla__plg_webservices_componentbuilderapiroutes__6.x.zip -o "$source_dir/routes.zip"
unzip -q "$source_dir/routes.zip" -d "$source_dir/plugins"
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
filters, ordering keys and 21 GUID-capable families as 6.2.1. Version 6.2.1
adds 40 explicit conditional-requirement groups in nine models. The bundled
descriptions include those groups. Both releases disable the language
translation source at creation. The comparison used the official
[6.2.0 component](https://github.com/vdm-io/Joomla-Component-Builder/tree/bb9b155f00c4ffd6de285de6fab9db4fec538ee8)
and [6.2.0 package](https://github.com/joomengine/pkg-component-builder/tree/c39005da5eec7011847831618dbb9cb11dba73b4).

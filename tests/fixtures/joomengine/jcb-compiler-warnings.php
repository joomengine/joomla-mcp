<?php

declare(strict_types=1);

// This fixture-only observer keeps values substituted into Joomla messages
// private. Persist just recognized identifiers from installed language files.
register_shutdown_function(static function (): void {
    try {
        $runtime = dirname(__DIR__, 3);
        $work = getenv('JOOMLA_MCP_JCB_ARTIFACT_DIR');
        $job = is_string($work) ? basename(dirname($work)) : '';
        if (!preg_match('/^[a-f0-9]{64}$/D', $job) || $work !== "$runtime/jobs/$job/work"
            || !class_exists(\Joomla\CMS\Factory::class, false)) {
            return;
        }
        $warnings = [];
        foreach (\Joomla\CMS\Factory::$application?->getMessageQueue() ?? [] as $type => $messages) {
            if (strtolower((string) $type) === 'warning') {
                array_push($warnings, ...(array) $messages);
            }
        }
        if (!$warnings) {
            return;
        }
        $normalize = static fn (string $text): string =>
            trim(preg_replace('/\s+/u', ' ', html_entity_decode(strip_tags($text))) ?? '');
        $groups = array_map(static fn ($text) => $normalize((string) $text), array_slice($warnings, 0, 20));
        $matches = array_fill(0, count($groups), []);
        $english = JPATH_ADMINISTRATOR . '/language/en-GB/';
        $patterns = [$english . '*componentbuilder*.ini', $english . '*joomla.ini',
            JPATH_PLUGINS . '/*/componentbuilder*/language/en-GB/*.ini',
            JPATH_ADMINISTRATOR . '/components/com_componentbuilder/language/en-GB/*.ini'];
        $files = [];
        foreach ($patterns as $pattern) {
            foreach (glob($pattern) ?: [] as $path) {
                $files[$path] = true;
            }
        }
        foreach (array_keys($files) as $file) {
            foreach (@parse_ini_file($file, false, INI_SCANNER_RAW) ?: [] as $key => $template) {
                if (!preg_match('/^(?:COM_COMPONENTBUILDER_|PLG_[A-Z_]*COMPONENTBUILDER|J)[A-Z0-9_]{1,210}$/D', (string) $key)) {
                    continue;
                }
                $parts = preg_split('/%(?:[1-9][0-9]*\$)?[dsif]/i', $normalize((string) $template));
                if (!$parts || strlen(implode('', $parts)) < 6) {
                    continue;
                }
                $regex = '~\A' . implode('.{0,2048}?', array_map(static fn ($part) => preg_quote($part, '~'), $parts)) . '\z~usD';
                foreach ($groups as $i => $warning) {
                    if (strlen($warning) <= 8192 && count($matches[$i]) < 4
                        && ($warning === $key || preg_match($regex, $warning) === 1)) {
                        $matches[$i][$key] = true;
                    }
                }
            }
        }
        $report = ['total' => count($warnings), 'recognizedKeys' => array_map('array_keys', $matches)];
        file_put_contents("$runtime/jcb-warnings-$job.json", json_encode($report, JSON_THROW_ON_ERROR), LOCK_EX);
    } catch (\Throwable) {
        // Diagnostic matching must not replace or corrupt the native CLI result.
    }
});

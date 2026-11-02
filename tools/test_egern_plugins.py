import unittest

from sync_egern_plugins import render


class EgernPluginTests(unittest.TestCase):
    def test_surge_arguments_and_nested_dependency(self):
        source = '#!name=Test\n#!arguments=Existing:true\n[Script]\ntest=script-path=https://cdn.jsdelivr.net/gh/ciallothu/proxy_plugins@main/scripts/test.js\n'
        result = render(source, {"scripts/test.js"})
        self.assertIn('Existing:true,GitLabToken:""', result)
        self.assertIn('modules%2Fegern%2Fscripts%2Ftest.js/raw?ref=main&private_token={{{GitLabToken}}}', result)
        self.assertNotIn('cdn.jsdelivr.net', result)

    def test_native_yaml_arguments_preserve_existing_defaults(self):
        source = 'name: Test\ncompat_arguments:\n  REGION: cn\nscript_url: https://raw.githubusercontent.com/felixbennettio/proxy_plugins/main/scripts/test.js\n'
        result = render(source, {"scripts/test.js"}, yaml_module=True)
        self.assertIn('compat_arguments:\n  GitLabToken: ""\n  REGION: cn', result)
        self.assertIn('private_token={{{GitLabToken}}}', result)

    def test_missing_dependency_rejects_snapshot(self):
        with self.assertRaisesRegex(ValueError, 'Missing plugin dependency'):
            render('script-path=https://cdn.jsdelivr.net/gh/ciallothu/proxy_plugins@main/scripts/missing.js', set())

    def test_module_without_dependencies_remains_identical(self):
        source = '#!name=Test\n[Rule]\nDOMAIN,example.com,REJECT\n'
        self.assertEqual(render(source, set()), source)

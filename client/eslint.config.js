import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

const iconStrokeWidthRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce consistent icon stroke width for JSX icons',
    },
    schema: [],
    messages: {
      invalid: 'Use strokeWidth="2" (or strokeWidth={2}) for icon consistency.',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (!node.name || node.name.type !== 'JSXIdentifier' || node.name.name !== 'strokeWidth') {
          return
        }

        const value = node.value
        if (!value) {
          context.report({ node, messageId: 'invalid' })
          return
        }

        // strokeWidth="2"
        if (value.type === 'Literal') {
          if (value.value === '2' || value.value === 2) return
          context.report({ node, messageId: 'invalid' })
          return
        }

        // strokeWidth={2}
        if (value.type === 'JSXExpressionContainer') {
          const expr = value.expression
          if (expr && expr.type === 'Literal' && expr.value === 2) return
          context.report({ node, messageId: 'invalid' })
          return
        }

        context.report({ node, messageId: 'invalid' })
      },
    }
  },
}

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    plugins: {
      local: {
        rules: {
          'icon-stroke-width': iconStrokeWidthRule,
        },
      },
    },
    rules: {
      'local/icon-stroke-width': 'error',
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])

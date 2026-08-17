import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

// The nav version comes from the root package.json — it was a hand-maintained
// string once and promptly went stale on the next release.
const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
  version: string;
};

const site = 'https://mcp-hub.ni-c.de';
const description =
  'Serve many stdio MCP servers from one container: Claude-Code-style config, path-based routing, hub meta-tools, and OAuth 2.1 + API tokens for ChatGPT, Claude and any Streamable-HTTP MCP client.';

export default defineConfig({
  title: 'mcp-hub',
  description,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: site },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'mcp-hub' }],
    ['meta', { property: 'og:title', content: 'mcp-hub — one container for all your MCP servers' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { property: 'og:image', content: `${site}/og.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${site}/og.png` }]
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'mcp-hub',

    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/endpoints', activeMatch: '/reference/' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: '/reference/changelog' },
          { text: 'Releases', link: 'https://github.com/ni-c/mcp-hub/releases' },
          { text: 'npm package', link: 'https://www.npmjs.com/package/@ni-c/mcp-hub' },
          { text: 'Container image', link: 'https://github.com/ni-c/mcp-hub/pkgs/container/mcp-hub' }
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is mcp-hub?', link: '/guide/' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Connecting clients', link: '/guide/clients' },
            { text: 'Client compatibility', link: '/guide/client-compatibility' }
          ]
        },
        {
          text: 'Operating it',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Sandboxing servers', link: '/guide/sandboxing' },
            { text: 'Security', link: '/guide/security' },
            { text: 'FAQ & troubleshooting', link: '/guide/faq' }
          ]
        },
        {
          text: 'Background',
          items: [
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Comparison', link: '/guide/comparison' }
          ]
        }
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'HTTP endpoints', link: '/reference/endpoints' },
            { text: 'Hub meta-tools', link: '/reference/hub-tools' },
            { text: 'Environment variables', link: '/reference/environment' },
            { text: 'Changelog', link: '/reference/changelog' }
          ]
        }
      ]
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/ni-c/mcp-hub' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/ni-c/mcp-hub/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },

    outline: { level: [2, 3] },

    footer: {
      message:
        'Released under the MIT License. Not affiliated with Anthropic; “Claude” is a trademark of Anthropic PBC.',
      copyright: 'Copyright © 2026 Willi Thiel'
    }
  },

  markdown: {
    // The *-default variants darken comments enough to clear 4.5:1 against the
    // code background; plain github-light lands just under it.
    theme: { light: 'github-light-default', dark: 'github-dark-default' }
  }
});

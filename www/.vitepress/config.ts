import { defineConfig } from 'vitepress';
import '../.vitepress/theme/custom.css';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'REMQ',
  description:
    'Redis Enhanced Message Queue - A high-performance message queue system for Deno',
  base: '/',
  head: [['link', { rel: 'icon', href: '/favicon.ico' }]],
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo.png',
    siteTitle: 'REMQ',

    nav: [
      { text: 'Docs', link: '/guide/' },
      {
        text: 'GitHub',
        link: 'https://github.com/mirairoad/tempotask',
        target: '_blank',
      },
      {
        text: 'JSR',
        link: 'https://jsr.io/@leotermine/tasker',
        target: '_blank',
      },
    ],

    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
          ],
        },
      ],
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Task Management', link: '/guide/task-management' },
            { text: 'Message Queues', link: '/guide/message-queues' },
            { text: 'Consumers', link: '/guide/consumers' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Remq', link: '/reference/task-manager' },
            { text: 'Consumer', link: '/reference/consumer' },
            { text: 'Processor', link: '/reference/processor' },
            { text: 'RemqAdmin', link: '/reference/sdk' },
          ],
        },
      ],
    },

    darkModeSwitchLabel: 'Appearance',

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024',
    },
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
    root: '.',
    base: '/samplez_studio/',
    build: {
        rollupOptions: {
            input: './index.html',
        },
    },
});
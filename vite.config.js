import { defineConfig } from 'vite';

export default defineConfig({
    root: '.',
    base: '/jameskelleher/',
    build: {
        rollupOptions: {
            input: './index.html',
        },
    },
});
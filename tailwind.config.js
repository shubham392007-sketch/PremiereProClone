/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          bg: '#181818',
          panel: '#202020',
          panel2: '#262626',
          panel3: '#2d2d2d',
          border: '#353535',
          borderStrong: '#454545',
          text: '#E5E5E5',
          textDim: '#A0A0A0',
          textFaint: '#6e6e6e',
          accent: '#3988F5',
          accentDim: '#2b6fc9',
          selection: '#23508c',
          danger: '#e05252',
          warning: '#d9a33a',
          success: '#4caf7d',
        },
        track: {
          video: '#2b4a6f',
          audio: '#2f5548',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Consolas', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '12px'],
        '3xs': ['9px', '11px'],
      },
    },
  },
  plugins: [],
};

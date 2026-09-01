/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        moss: {
          50: "#f4f7f2",
          100: "#e4eee0",
          200: "#c9dcbd",
          500: "#5b7a4a",
          700: "#3d5433",
          900: "#1f2b1a",
        },
        sand: {
          50: "#faf7f2",
          100: "#f1eadc",
          400: "#c4b08a",
        },
        sea: {
          400: "#6a9caf",
          600: "#3d7388",
        },
      },
      fontFamily: {
        sans: ['"Source Han Sans SC"', '"Noto Sans SC"', "ui-sans-serif", "system-ui", "sans-serif"],
        display: ['"Source Han Serif SC"', '"Noto Serif SC"', "Georgia", "serif"],
      },
      boxShadow: {
        card: "0 18px 50px -24px rgb(31 43 26 / 0.35)",
      },
    },
  },
  plugins: [],
}

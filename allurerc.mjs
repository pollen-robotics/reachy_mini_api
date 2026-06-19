import { defineConfig } from "allure";

export default defineConfig({
  name: "Reachy Mini API Tests",
  output: "./allure-report",
  historyPath: "./history/history.jsonl",
  plugins: {
    awesome: {
      import: "@allurereport/plugin-awesome",
      options: {
        reportName: "Reachy Mini API Tests",
        singleFile: false,
      },
    },
  },
});

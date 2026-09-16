module.exports = class {
  id() { return "cyberdeck-host-evidence-v1"; }
  async callApi(prompt) { return { output: prompt }; }
};

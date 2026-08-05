export default (previous) => ({
  ...previous,
  Button: (label) => `compact:${previous.Button(label)}`,
  spacing: 4,
})

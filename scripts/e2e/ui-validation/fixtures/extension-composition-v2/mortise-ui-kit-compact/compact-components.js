export default (previous) => ({
  ...previous,
  Button: (options = {}) => previous.Button({ ...options, className: `compact ${options.className ?? ''}` }),
  spacing: 4,
})

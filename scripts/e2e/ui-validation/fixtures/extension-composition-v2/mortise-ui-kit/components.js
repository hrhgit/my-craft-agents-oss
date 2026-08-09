const element = (tag, options = {}) => {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  if (options.semanticId) {
    node.dataset.mortiseUiSemantic = options.semanticId
    node.dataset.mortiseSemanticId = options.semanticId
  }
  return node
}

export const Stack = (options = {}) => element('div', { ...options, className: `mortise-kit-stack ${options.className ?? ''}` })
export const Row = (options = {}) => element('div', { ...options, className: `mortise-kit-row ${options.className ?? ''}` })
export const Toolbar = (options = {}) => element('div', { ...options, className: `mortise-kit-toolbar ${options.className ?? ''}` })
export const Divider = () => element('hr', { className: 'mortise-kit-divider' })
export const Button = ({ label, onClick, ...options } = {}) => {
  const node = element('button', { ...options, text: label })
  node.type = 'button'
  if (onClick) node.addEventListener('click', onClick)
  return node
}
export const Badge = ({ label, ...options } = {}) => element('span', { ...options, text: label, className: `mortise-kit-badge ${options.className ?? ''}` })
export const Status = Badge
export const EmptyState = ({ label = 'Nothing here', ...options } = {}) => element('p', { ...options, text: label })

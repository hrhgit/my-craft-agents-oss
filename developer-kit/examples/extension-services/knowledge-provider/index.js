const knowledge = {
  composition: 'Composition lets a consumer select stable capabilities from independent providers without copying source code.',
  mortise: 'Mortise keeps extension installation and failure isolation separate from capability binding and service invocation.',
}

export default function knowledgeProvider(pi) {
  pi.services.provide('knowledge.read', {
    async read(input) {
      return { text: knowledge[String(input.topic).toLowerCase()] ?? `No example knowledge is available for ${input.topic}.` }
    },
  })
}

// lint-staged passes explicit file paths to each command. eslint emits a
// "File ignored because of a matching ignore pattern" warning when handed a
// path that .eslintignore covers (e.g. the generated tests/types/*), and our
// `--max-warnings=0` turns that warning into a failure. So we filter
// eslint-ignored paths out of the eslint task while still formatting them.
const quote = (files) => files.map((f) => `"${f}"`).join(' ')

const isEslintIgnored = (file) => file.replaceAll('\\', '/').includes('/tests/types/')

export default {
  '{src,tests}/**/*.{ts,tsx}': (files) => {
    const lintable = files.filter((f) => !isEslintIgnored(f))
    const tasks = []
    if (lintable.length > 0) {
      tasks.push(`eslint --fix --max-warnings=0 ${quote(lintable)}`)
    }
    tasks.push(`prettier --write ${quote(files)}`)
    return tasks
  },
  'README.md': ['markdown-toc-gen insert --max-depth 2', 'prettier --write'],
  '!(README).{json,md,yml,yaml}': 'prettier --write',
}

// Command convert-html converts one HTML file into a markdown staging document
// plus a retained copy of the original, implementing the O10 ingest contract.
//
//	convert-html <input> --inbox DIR --sources DIR [--source-url URL] [--json]
//
// Output: one line of JSON on stdout. Exit codes:
//
//	0  ok
//	2  usage error
//	3  parse failure
//	4  source unreadable
//
// Guarantees:
//   - deterministic: same input bytes -> same markdown body (converted_at is
//     taken from SOURCE_DATE_EPOCH when set, so tests can pin it)
//   - idempotent: if the staging file already records this source sha256, it is
//     left untouched (mtime preserved)
//   - atomic: staging file is written to a temp file in the same directory and
//     renamed into place; a non-zero exit never leaves a partial file
//   - identity is the *input* hash, never the output hash
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	converterName = "convert-html"
	version       = "0.1.0"
	// fidelity: the body text survives, presentation does not. Stylesheets,
	// scripts, layout tables and CSS-only structure are dropped, so the
	// original is retained in raw/sources/ as the verification oracle.
	fidelity = "lossy"
)

// Exit codes, matching the O10 contract.
const (
	exitOK         = 0
	exitUsage      = 2
	exitParse      = 3
	exitUnreadable = 4
)

type result struct {
	OK         bool   `json:"ok"`
	Inbox      string `json:"inbox"`
	Source     string `json:"source"`
	SHA256     string `json:"sha256"`
	Title      string `json:"title"`
	Fidelity   string `json:"fidelity"`
	Converter  string `json:"converter"`
	Version    string `json:"version"`
	BodyBytes  int    `json:"body_bytes"`
	Skipped    bool   `json:"skipped"`
	SkipReason string `json:"skip_reason,omitempty"`
}

func main() {
	os.Exit(run())
}

func run() int {
	fs := flag.NewFlagSet(converterName, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	inbox := fs.String("inbox", "", "staging directory for converted markdown (required)")
	sources := fs.String("sources", "", "directory for the retained original (required)")
	sourceURL := fs.String("source-url", "", "origin URL, recorded when the input is a local copy of a fetched page")
	asJSON := fs.Bool("json", false, "print a one-line JSON result on stdout")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: %s <input.html> --inbox DIR --sources DIR [--source-url URL] [--json]\n", converterName)
		fs.PrintDefaults()
	}
	// The O10 contract puts the input path first (wiki-convert <input> --inbox …),
	// but Go's flag package stops at the first non-flag argument. Move any
	// leading positionals to the end so both orders work.
	args := os.Args[1:]
	var positional []string
	for len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		positional = append(positional, args[0])
		args = args[1:]
	}
	args = append(args, positional...)
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() != 1 {
		fmt.Fprintf(os.Stderr, "%s: expected exactly one input path, got %d\n", converterName, fs.NArg())
		return exitUsage
	}
	if *inbox == "" || *sources == "" {
		fmt.Fprintf(os.Stderr, "%s: --inbox and --sources are required\n", converterName)
		return exitUsage
	}

	input := fs.Arg(0)
	absInput, err := filepath.Abs(input)
	if err != nil {
		absInput = input
	}
	raw, err := os.ReadFile(absInput)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot read %s: %v\n", converterName, absInput, err)
		return exitUnreadable
	}

	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	short := hash[:16]

	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot parse %s: %v\n", converterName, absInput, err)
		return exitParse
	}

	title := documentTitle(doc)
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(absInput), filepath.Ext(absInput))
	}

	body := renderMarkdown(doc)

	origin := *sourceURL
	if origin == "" {
		origin = "file:" + absInput
	}

	ext := strings.ToLower(filepath.Ext(absInput))
	if ext == "" {
		ext = ".html"
	}

	front := buildFrontmatter(title, origin, hash, filepath.Base(absInput), ext)
	content := front + "\n" + body

	if err := os.MkdirAll(*inbox, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot create inbox %s: %v\n", converterName, *inbox, err)
		return exitUsage
	}
	if err := os.MkdirAll(*sources, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot create sources %s: %v\n", converterName, *sources, err)
		return exitUsage
	}

	inboxPath := filepath.Join(*inbox, short+".md")
	sourcePath := filepath.Join(*sources, hash+ext)

	res := result{
		OK: true, Inbox: inboxPath, Source: sourcePath, SHA256: hash,
		Title: title, Fidelity: fidelity, Converter: converterName,
		Version: version, BodyBytes: len(body),
	}

	// Idempotency: the staging file is named after the input hash, so if it
	// already records that hash the conversion is already done. Leave it alone
	// (this preserves mtime, which the pipeline's drift detection depends on).
	if prev, rerr := os.ReadFile(inboxPath); rerr == nil && recordsHash(prev, hash) {
		res.Skipped = true
		res.SkipReason = "already converted from this source hash"
		if _, serr := os.Stat(sourcePath); serr != nil {
			// The markdown exists but the oracle is missing: restore it.
			if werr := atomicWrite(sourcePath, raw); werr != nil {
				fmt.Fprintf(os.Stderr, "%s: cannot restore %s: %v\n", converterName, sourcePath, werr)
				return exitUsage
			}
			res.SkipReason = "already converted; restored missing original"
		}
		return emit(res, *asJSON)
	}

	// Retain the original first: if this fails we must not leave a staging file
	// that points at an oracle which does not exist.
	if err := atomicWrite(sourcePath, raw); err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot write %s: %v\n", converterName, sourcePath, err)
		return exitUsage
	}
	if err := atomicWrite(inboxPath, []byte(content)); err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot write %s: %v\n", converterName, inboxPath, err)
		return exitUsage
	}
	return emit(res, *asJSON)
}

func emit(r result, asJSON bool) int {
	if !asJSON {
		fmt.Printf("%s: %s -> %s (%d bytes body, fidelity=%s)\n", converterName, r.SHA256[:16], r.Inbox, r.BodyBytes, r.Fidelity)
		return exitOK
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(r); err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot marshal result: %v\n", converterName, err)
		return exitUsage
	}
	fmt.Print(b.String())
	return exitOK
}

// recordsHash reports whether a staging file already records this source hash.
// The frontmatter writer emits sha256 as a bare scalar, but a hand-edited file
// may quote it, so both forms are accepted. Only the frontmatter block is
// searched: the body could legitimately contain the hash too.
func recordsHash(content []byte, hash string) bool {
	front := content
	if i := bytes.Index(content, []byte("\n---\n")); i >= 0 {
		front = content[:i]
	}
	for _, form := range []string{`sha256: "` + hash + `"`, "sha256: " + hash} {
		if bytes.Contains(front, []byte(form)) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

// buildFrontmatter emits the seven required O10 fields, in a fixed order, using
// only constructs the controlled YAML subset in scripts/lib/frontmatter.mjs can
// parse back (plain scalars, or JSON-compatible double-quoted scalars).
func buildFrontmatter(title, source, hash, originalName, ext string) string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(title))
	fmt.Fprintf(&b, "source: %s\n", yamlScalar(source))
	fmt.Fprintf(&b, "sha256: %s\n", yamlScalar(hash))
	fmt.Fprintf(&b, "original_name: %s\n", yamlScalar(originalName))
	fmt.Fprintf(&b, "converted_by: %s\n", yamlScalar(converterName+"@"+version))
	fmt.Fprintf(&b, "converted_at: %s\n", yamlScalar(convertedAt()))
	fmt.Fprintf(&b, "fidelity: %s\n", yamlScalar(fidelity))
	_ = ext
	b.WriteString("---\n")
	return b.String()
}

// yamlScalar quotes a value when leaving it bare would be ambiguous or would
// break the subset parser. Double quotes are JSON-escaped, which is exactly how
// frontmatter.mjs decodes them.
func yamlScalar(s string) string {
	// Control characters cannot survive the subset parser; drop them.
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return `""`
	}
	bare := true
	if strings.ContainsAny(s, ":#{}[]&*!|>'\"%@`,\\") {
		bare = false
	}
	if s[0] == ' ' || s[len(s)-1] == ' ' || s[0] == '-' || s[0] == '?' {
		bare = false
	}
	// A bare scalar that looks like a number or boolean would round-trip as a
	// non-string in a real YAML parser.
	switch strings.ToLower(s) {
	case "true", "false", "null", "yes", "no", "on", "off", "~":
		bare = false
	}
	if _, err := strconv.ParseFloat(s, 64); err == nil {
		bare = false
	}
	if bare {
		return s
	}
	return jsonQuote(s)
}

// jsonQuote produces a JSON string literal without Go's default HTML escaping,
// so "&" stays "&" instead of "\u0026". frontmatter.mjs decodes these with
// JSON.parse, so the escaping only has to be valid, but readable wins.
func jsonQuote(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return `""`
	}
	return strings.TrimRight(b.String(), "\n")
}

// convertedAt is pinned by SOURCE_DATE_EPOCH so the output is reproducible.
func convertedAt() string {
	if v := os.Getenv("SOURCE_DATE_EPOCH"); v != "" {
		if sec, err := strconv.ParseInt(v, 10, 64); err == nil {
			return time.Unix(sec, 0).UTC().Format(time.RFC3339)
		}
	}
	return time.Now().UTC().Format(time.RFC3339)
}

// ---------------------------------------------------------------------------
// atomic write
// ---------------------------------------------------------------------------

func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".convert-html-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o644); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// ---------------------------------------------------------------------------
// markdown renderer
// ---------------------------------------------------------------------------

type renderer struct {
	buf        []byte
	preDepth   int
	listStack  []string // "ul" or "ol", one entry per open list
	olCounters []int
}

func (r *renderer) write(s string) { r.buf = append(r.buf, s...) }
func (r *renderer) str() string    { return string(r.buf) }
func (r *renderer) len() int       { return len(r.buf) }

// trimTrailingSpace drops trailing spaces, tabs and newlines from the buffer.
func (r *renderer) trimTrailingSpace() {
	for len(r.buf) > 0 {
		c := r.buf[len(r.buf)-1]
		if c == ' ' || c == '\t' || c == '\n' {
			r.buf = r.buf[:len(r.buf)-1]
			continue
		}
		break
	}
}

// blank guarantees a blank line before the next block, if anything is buffered.
func (r *renderer) blank() {
	if len(r.buf) == 0 {
		return
	}
	if bytes.HasSuffix(r.buf, []byte("\n\n")) {
		return
	}
	if bytes.HasSuffix(r.buf, []byte("\n")) {
		r.write("\n")
		return
	}
	r.write("\n\n")
}

// lineStart guarantees the buffer ends with a newline (for list items).
func (r *renderer) lineStart() {
	if len(r.buf) == 0 {
		return
	}
	if !bytes.HasSuffix(r.buf, []byte("\n")) {
		r.write("\n")
	}
}

func (r *renderer) children(n *html.Node) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		r.walk(c)
	}
}

func (r *renderer) walk(n *html.Node) {
	switch n.Type {
	case html.TextNode:
		r.text(n.Data)
	case html.ElementNode:
		r.element(n)
	}
}

func isSpaceByte(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }

func (r *renderer) text(s string) {
	if r.preDepth > 0 {
		r.write(s)
		return
	}
	collapsed := strings.Join(strings.Fields(s), " ")
	if collapsed == "" {
		// A whitespace-only node still separates two inline siblings.
		if len(r.buf) > 0 {
			last := r.buf[len(r.buf)-1]
			if last != ' ' && last != '\n' {
				r.write(" ")
			}
		}
		return
	}
	lead := len(s) > 0 && isSpaceByte(s[0])
	trail := len(s) > 0 && isSpaceByte(s[len(s)-1])
	if lead && len(r.buf) > 0 {
		last := r.buf[len(r.buf)-1]
		if last != ' ' && last != '\n' {
			r.write(" ")
		}
	}
	r.write(collapsed)
	if trail {
		r.write(" ")
	}
}

var skippedElements = map[string]bool{
	"script": true, "style": true, "head": true, "noscript": true,
	"template": true, "svg": true, "canvas": true, "iframe": true,
	"object": true, "embed": true, "map": true, "area": true,
}

var blockElements = map[string]bool{
	"p": true, "div": true, "section": true, "article": true, "header": true,
	"footer": true, "main": true, "aside": true, "nav": true, "figure": true,
	"figcaption": true, "dl": true, "dd": true, "dt": true, "form": true,
	"fieldset": true, "address": true, "details": true, "summary": true,
	"center": true, "caption": true,
}

func (r *renderer) element(n *html.Node) {
	if skippedElements[n.Data] {
		return
	}
	switch n.Data {
	case "h1", "h2", "h3", "h4", "h5", "h6":
		r.blank()
		lvl := int(n.Data[1] - '0')
		r.write(strings.Repeat("#", lvl) + " ")
		r.children(n)
		r.trimTrailingSpace()
		r.write("\n")

	case "br":
		r.trimTrailingSpace()
		r.write("\n")

	case "hr":
		r.blank()
		r.write("---\n")

	case "ul", "ol":
		nested := len(r.listStack) > 0
		if nested {
			r.lineStart()
		} else {
			r.blank()
		}
		r.listStack = append(r.listStack, n.Data)
		r.olCounters = append(r.olCounters, 0)
		r.children(n)
		r.listStack = r.listStack[:len(r.listStack)-1]
		r.olCounters = r.olCounters[:len(r.olCounters)-1]
		if !nested {
			r.write("\n")
		}

	case "li":
		r.lineStart()
		depth := len(r.listStack)
		indent := strings.Repeat("  ", max(depth-1, 0))
		marker := "- "
		if depth > 0 && r.listStack[depth-1] == "ol" {
			r.olCounters[depth-1]++
			marker = strconv.Itoa(r.olCounters[depth-1]) + ". "
		}
		r.write(indent + marker)
		r.children(n)
		r.trimTrailingSpace()
		r.write("\n")

	case "pre":
		sub := &renderer{preDepth: 1}
		sub.children(n)
		code := strings.TrimRight(sub.str(), "\n")
		code = strings.ReplaceAll(code, "\r\n", "\n")
		if strings.TrimSpace(code) == "" {
			return
		}
		fence := "```"
		run := 0
		for i := 0; i < len(code); i++ {
			if code[i] == '`' {
				run++
				if run >= len(fence) {
					fence = strings.Repeat("`", run+1)
				}
			} else {
				run = 0
			}
		}
		r.blank()
		r.write(fence + "\n" + code + "\n" + fence + "\n")

	case "code", "kbd", "samp", "tt":
		if r.preDepth > 0 {
			r.children(n)
			return
		}
		sub := &renderer{preDepth: 1}
		sub.children(n)
		s := strings.TrimSpace(sub.str())
		if s == "" {
			return
		}
		ticks := "`"
		for strings.Contains(s, ticks) {
			ticks += "`"
		}
		r.write(ticks + s + ticks)

	case "blockquote":
		sub := &renderer{}
		sub.children(n)
		inner := strings.Trim(strings.ReplaceAll(sub.str(), "\r\n", "\n"), "\n")
		if strings.TrimSpace(inner) == "" {
			return
		}
		r.blank()
		for _, line := range strings.Split(inner, "\n") {
			if strings.TrimSpace(line) == "" {
				r.write(">\n")
				continue
			}
			r.write("> " + line + "\n")
		}
		r.write("\n")

	case "a":
		href, _ := attr(n, "href")
		label := plainText(n)
		href = strings.TrimSpace(href)
		if href == "" || strings.HasPrefix(strings.ToLower(href), "javascript:") {
			r.write(label)
			return
		}
		if label == "" || label == href {
			r.write("<" + escapeURL(href) + ">")
			return
		}
		r.write("[" + label + "](" + escapeURL(href) + ")")

	case "img":
		src, _ := attr(n, "src")
		alt, _ := attr(n, "alt")
		if strings.TrimSpace(src) == "" {
			return
		}
		r.write("![" + strings.Join(strings.Fields(alt), " ") + "](" + escapeURL(src) + ")")

	case "strong", "b":
		r.wrap(n, "**", "**")
	case "em", "i":
		r.wrap(n, "*", "*")
	case "del", "s", "strike":
		r.wrap(n, "~~", "~~")

	case "table":
		r.table(n)

	default:
		if blockElements[n.Data] {
			r.blank()
			r.children(n)
			r.trimTrailingSpace()
			r.write("\n")
			return
		}
		r.children(n)
	}
}

// wrap renders children and surrounds them only when they produce text.
func (r *renderer) wrap(n *html.Node, open, close string) {
	sub := &renderer{}
	sub.children(n)
	s := sub.str()
	if strings.TrimSpace(s) == "" {
		return
	}
	// Do not add emphasis around leading/trailing whitespace.
	lead := s[:len(s)-len(strings.TrimLeft(s, " \t\n"))]
	trail := s[len(strings.TrimRight(s, " \t\n")):]
	r.write(lead + open + strings.TrimSpace(s) + close + trail)
}

func (r *renderer) table(n *html.Node) {
	rows := collectRows(n)
	if len(rows) == 0 {
		return
	}
	cols := 0
	for _, row := range rows {
		if len(row) > cols {
			cols = len(row)
		}
	}
	for i := range rows {
		for len(rows[i]) < cols {
			rows[i] = append(rows[i], "")
		}
	}
	r.blank()
	r.write("| " + strings.Join(rows[0], " | ") + " |\n")
	r.write("|" + strings.Repeat(" --- |", cols) + "\n")
	for _, row := range rows[1:] {
		r.write("| " + strings.Join(row, " | ") + " |\n")
	}
	r.write("\n")
}

func collectRows(tbl *html.Node) [][]string {
	var rows [][]string
	var findRows func(*html.Node)
	findRows = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			if c.Data == "tr" {
				var cells []string
				for cell := c.FirstChild; cell != nil; cell = cell.NextSibling {
					if cell.Type == html.ElementNode && (cell.Data == "td" || cell.Data == "th") {
						cells = append(cells, cellText(cell))
					}
				}
				if len(cells) > 0 {
					rows = append(rows, cells)
				}
				continue
			}
			if c.Data == "thead" || c.Data == "tbody" || c.Data == "tfoot" {
				findRows(c)
			}
		}
	}
	findRows(tbl)
	return rows
}

func cellText(n *html.Node) string {
	sub := &renderer{}
	sub.children(n)
	s := strings.Join(strings.Fields(sub.str()), " ")
	s = strings.ReplaceAll(s, "\\", "\\\\")
	return strings.ReplaceAll(s, "|", "\\|")
}

func plainText(n *html.Node) string {
	sub := &renderer{}
	sub.children(n)
	return strings.Join(strings.Fields(sub.str()), " ")
}

func attr(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}

func escapeURL(u string) string {
	u = strings.ReplaceAll(u, " ", "%20")
	u = strings.ReplaceAll(u, "(", "%28")
	u = strings.ReplaceAll(u, ")", "%29")
	return u
}

// ---------------------------------------------------------------------------
// document-level helpers
// ---------------------------------------------------------------------------

func documentTitle(doc *html.Node) string {
	if t := firstText(doc, "title"); t != "" {
		return t
	}
	for _, tag := range []string{"h1", "h2"} {
		if t := firstText(doc, tag); t != "" {
			return t
		}
	}
	return ""
}

func firstText(n *html.Node, tag string) string {
	var found string
	var walk func(*html.Node) bool
	walk = func(cur *html.Node) bool {
		if cur.Type == html.ElementNode && cur.Data == tag {
			found = strings.Join(strings.Fields(textContent(cur)), " ")
			return true
		}
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			if walk(c) {
				return true
			}
		}
		return false
	}
	walk(n)
	return found
}

func textContent(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		if cur.Type == html.TextNode {
			b.WriteString(cur.Data)
		}
		if cur.Type == html.ElementNode && skippedElements[cur.Data] {
			return
		}
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// renderMarkdown walks the parsed document and returns a normalized body.
func renderMarkdown(doc *html.Node) string {
	body := &html.Node{}
	// Prefer <body> when present so <head> content cannot leak in.
	if b := findElement(doc, "body"); b != nil {
		body = b
	} else {
		body = doc
	}
	r := &renderer{}
	r.children(body)
	return postProcess(r.str())
}

func findElement(n *html.Node, tag string) *html.Node {
	if n.Type == html.ElementNode && n.Data == tag {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findElement(c, tag); found != nil {
			return found
		}
	}
	return nil
}

// postProcess normalizes whitespace: collapse runs of spaces outside fenced
// code, trim trailing spaces, collapse 3+ newlines to 2, and end with one \n.
func postProcess(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	blanks := 0
	for _, line := range lines {
		trimmed := strings.TrimRight(line, " \t")
		if strings.HasPrefix(strings.TrimLeft(trimmed, " "), "```") {
			inFence = !inFence
		}
		if !inFence && !strings.HasPrefix(trimmed, "|") {
			trimmed = collapseSpaces(trimmed)
		}
		if strings.TrimSpace(trimmed) == "" {
			blanks++
			if blanks > 1 {
				continue
			}
			out = append(out, "")
			continue
		}
		blanks = 0
		out = append(out, trimmed)
	}
	res := strings.Trim(strings.Join(out, "\n"), "\n")
	if res == "" {
		return ""
	}
	return res + "\n"
}

// collapseSpaces squeezes internal space runs while preserving leading
// indentation (nested list items depend on it).
func collapseSpaces(line string) string {
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	lead, rest := line[:i], line[i:]
	for strings.Contains(rest, "  ") {
		rest = strings.ReplaceAll(rest, "  ", " ")
	}
	return lead + rest
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

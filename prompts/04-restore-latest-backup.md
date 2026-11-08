# Prompt 4: সর্বশেষ backup থেকে restore

**Skill:** `.claude/skills/content-replace.md` step 3 (backup/restore নিয়ম)

| Placeholder | মানে | উদাহরণ |
|-------------|------|--------|
| `{RUN_FILE}` | যে run copy restore করতে হবে | `I:\Indesign\test_fixtures\runs\ch1-replace-2026-11-07.indd` |
| `{BACKUP_LABEL}` | (ঐচ্ছিক) নির্দিষ্ট label-এর backup | `before-ch1-replace` অথবা `latest` |

---

## বাংলা prompt (paste করুন)

```text
Skill: .claude/skills/content-replace.md-এর step 3 (backup) follow করো। এই prompt-এর সাথে মতভেদ হলে এই prompt চলবে।

কাজ: {RUN_FILE}-কে তার সর্বশেষ backup থেকে restore করো ({BACKUP_LABEL} দেওয়া থাকলে সেই label-এর সবচেয়ে নতুনটা)।

SAFETY:
- Target শুধু I:\Indesign\test_fixtures\runs বা I:\Indesign\test_output-এর ভেতরের .indd হতে পারে। BRAC_TEST_MASTER.indd বা Downloads-এর কিছু কখনো target হবে না। এমন হলে থামো।
- restore_backup target document-কে save না করেই বন্ধ করে। unsaved পরিবর্তন হারিয়ে যায়। তাই restore-এর আগে আমার স্পষ্ট "হ্যাঁ" লাগবে।
- Timeout এলে শুধু probe_indesign। কোনো ফাইল delete করবে না, পুরনো backup-ও না।

ধাপগুলো এই ক্রমে:
0. probe_indesign → list_open_documents ({RUN_FILE} খোলা কিনা, আর modified কিনা, get_active_document {document_id: {RUN_FILE}} দিয়ে)।
1. list_backups (default dir I:\Indesign\test_output\_backups)। শুধু সেই backup রাখো যার নাম {RUN_FILE}-এর base name দিয়ে শুরু (backup_document-এর নাম: <docName>_backup_<timestamp>[_label].indd)। নতুন থেকে পুরনো ক্রমে উপরের 5টা দেখাও: path, label, mtime, sizeBytes।
2. বেছে নাও: {BACKUP_LABEL} = latest হলে সবচেয়ে নতুনটা; না হলে সেই label-এর সবচেয়ে নতুনটা। কোনো backup না মিললে, বা size 0 বা অস্বাভাবিক ছোট হলে (v06 প্রায় 3.4 MB), থামো।
3. {RUN_FILE} খোলা আর modified থাকলে সতর্ক করো যে এই পরিবর্তন হারাবে। চাইলে প্রথমে backup_document {label: "pre-restore"} দিয়ে বর্তমান অবস্থা রেখে দেওয়ার প্রস্তাব দাও। তারপর বলো: "এই backup <path> দিয়ে <RUN_FILE> overwrite করব, ঠিক আছে?" আমার হ্যাঁ-র জন্য অপেক্ষা করো।
4. restore_backup {backupPath, targetPath: {RUN_FILE}}।
5. যাচাই: list_open_documents (restore হওয়া document খোলা আর writable); get_active_document {document_id: {RUN_FILE}} (page count, dimensions, modified: false); check_overset_text; list_pages (page count backup নেওয়ার সময়ের সাথে মেলে)। চাইলে export_jpeg দিয়ে 1–2টা মূল page দেখো।
6. close_document {document_id: {RUN_FILE}, save: "no"} (আমি খোলা রাখতে না বললে) → list_open_documents।

থামো এবং report করো, যদি: target write roots-এর বাইরে বা master হয়; মেলানো backup না থাকে; backup ফাইল ছোট বা নষ্ট মনে হয়; আমার অনুমতি না আসে; restore_backup error দেয় (error, code আর data হুবহু দেখাও, নিজে ফাইল copy করে workaround করবে না)।

Final report-এ থাকবে: কোন backup ব্যবহার হয়েছে (path, label, mtime, size), বাকি candidate-দের list, pre-restore backup নেওয়া হয়েছে কিনা, restore-এর পরের page count আর overset অবস্থা, document বন্ধ কিনা।
```

---

## English version (short)

```text
Follow content-replace.md step 3 (backup/restore); this prompt wins.

Task: restore {RUN_FILE} from its newest backup (or the newest one with label {BACKUP_LABEL}). The target must be a .indd under test_fixtures\runs or test_output, never the master and never Downloads. restore_backup closes the target WITHOUT saving, so get my explicit yes first. Delete nothing.

Steps: probe_indesign, list_open_documents, get_active_document → list_backups. Keep only backups whose name starts with the run file's base name, and show the newest 5 (path, label, mtime, size) → pick one (stop if there is none, or if it is tiny or empty; v06 is about 3.4 MB) → warn about unsaved changes and offer backup_document {label:"pre-restore"} → ask "overwrite <RUN_FILE> with <backup>?" and wait → restore_backup {backupPath, targetPath} → verify with list_open_documents, get_active_document, check_overset_text, list_pages → close_document {save:"no"}.

On a restore_backup error, show error/code/data verbatim and do not work around it by copying files.

Report: the backup used, the other candidates, whether a pre-restore backup was taken, page count and overset after the restore, closed status.
```

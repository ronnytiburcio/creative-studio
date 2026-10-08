CREATE TABLE `descriptions` (
	`sha256` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`text` text NOT NULL,
	`spoken_open` text,
	`ms` integer,
	`spoken_ms` integer,
	`first_image` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sha256`, `model`, `prompt_version`)
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `description_version` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `spoken_open` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `described_at` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `describe_error` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `describe_requested_at` integer;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `describe_state` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `describe_current` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `describe_note` text;--> statement-breakpoint
-- Plain search index over descriptions (hand written: drizzle-kit does not model FTS5). Kept in sync by the triggers
-- below, so every code path that inserts, renames or re-describes an asset updates it. rowid = assets.id.
CREATE VIRTUAL TABLE `asset_fts` USING fts5(`description`, `spoken_open`, `filename`, `rel_path`, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
--> statement-breakpoint
INSERT INTO `asset_fts` (`rowid`, `description`, `spoken_open`, `filename`, `rel_path`)
  SELECT `id`, coalesce(`description`, ''), coalesce(`spoken_open`, ''), `filename`, `rel_path` FROM `assets`;
--> statement-breakpoint
CREATE TRIGGER `asset_fts_ai` AFTER INSERT ON `assets` BEGIN
  INSERT INTO `asset_fts` (`rowid`, `description`, `spoken_open`, `filename`, `rel_path`)
    VALUES (new.`id`, coalesce(new.`description`, ''), coalesce(new.`spoken_open`, ''), new.`filename`, new.`rel_path`);
END;
--> statement-breakpoint
CREATE TRIGGER `asset_fts_ad` AFTER DELETE ON `assets` BEGIN
  DELETE FROM `asset_fts` WHERE `rowid` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `asset_fts_au` AFTER UPDATE OF `description`, `spoken_open`, `filename`, `rel_path` ON `assets`
  WHEN old.`description` IS NOT new.`description` OR old.`spoken_open` IS NOT new.`spoken_open`
    OR old.`filename` IS NOT new.`filename` OR old.`rel_path` IS NOT new.`rel_path`
BEGIN
  DELETE FROM `asset_fts` WHERE `rowid` = old.`id`;
  INSERT INTO `asset_fts` (`rowid`, `description`, `spoken_open`, `filename`, `rel_path`)
    VALUES (new.`id`, coalesce(new.`description`, ''), coalesce(new.`spoken_open`, ''), new.`filename`, new.`rel_path`);
END;

-- Phase 5 slice 2 (hand edited after drizzle-kit): client_works gets an owner section (Lane C owns a list with client_id null);
-- the copy backfills section_id from each row's client (drizzle-kit selected a column the old table does not have).
-- Only client_works is rebuilt (never `assets`, so the asset_fts triggers are untouched).
CREATE TABLE `hook_ads` (
	`hook_id` integer NOT NULL,
	`meta_ad_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`hook_id`, `meta_ad_id`, `role`),
	FOREIGN KEY (`hook_id`) REFERENCES `hooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hook_ads_ad_idx` ON `hook_ads` (`meta_ad_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_client_works` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer,
	`section_id` integer,
	`body` text,
	`hook_id` integer,
	`sort` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hook_id`) REFERENCES `hooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_client_works`("id", "client_id", "section_id", "body", "hook_id", "sort", "created_at", "updated_at") SELECT "id", "client_id", (SELECT c."section_id" FROM `clients` c WHERE c."id" = `client_works`."client_id"), "body", "hook_id", "sort", "created_at", "updated_at" FROM `client_works`;--> statement-breakpoint
DROP TABLE `client_works`;--> statement-breakpoint
ALTER TABLE `__new_client_works` RENAME TO `client_works`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `client_works_client_idx` ON `client_works` (`client_id`,`sort`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_works_hook_uniq` ON `client_works` (`client_id`,`hook_id`) WHERE hook_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `client_works_section_hook_uniq` ON `client_works` (`section_id`,`hook_id`) WHERE hook_id is not null and client_id is null;
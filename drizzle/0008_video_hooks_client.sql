CREATE TABLE `client_works` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`body` text,
	`hook_id` integer,
	`sort` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hook_id`) REFERENCES `hooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_works_client_idx` ON `client_works` (`client_id`,`sort`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_works_hook_uniq` ON `client_works` (`client_id`,`hook_id`) WHERE hook_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `hooks_video_asset_uniq` ON `hooks` (`asset_id`) WHERE kind = 'video' and parent_id is null;
CREATE TABLE `error_dismissals` (
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`error` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `ref_id`)
);

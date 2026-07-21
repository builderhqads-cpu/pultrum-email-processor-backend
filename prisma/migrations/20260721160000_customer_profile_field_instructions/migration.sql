-- A profile field may now exist with only an AI instruction (no fixed value):
-- for many customers the value changes every email, but HOW to find it does not.
ALTER TABLE "CustomerProfileField" ALTER COLUMN "value" DROP NOT NULL;

-- Free-text hint telling the AI how to locate this field in this customer's
-- documents (e.g. "10-cijferig nummer dat TR bevat").
ALTER TABLE "CustomerProfileField" ADD COLUMN "instruction" TEXT;

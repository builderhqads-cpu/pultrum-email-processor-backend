-- CreateTable
CREATE TABLE "OrderGoodsLine" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER,
    "packagingType" TEXT,
    "length" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "weightPerUnit" DOUBLE PRECISION,
    "barcode" TEXT,
    "productDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderGoodsLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderGoodsLine_orderId_idx" ON "OrderGoodsLine"("orderId");

-- AddForeignKey
ALTER TABLE "OrderGoodsLine" ADD CONSTRAINT "OrderGoodsLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TransportOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

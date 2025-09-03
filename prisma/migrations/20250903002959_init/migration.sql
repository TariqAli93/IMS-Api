-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `User_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Role` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` ENUM('ADMIN', 'MANAGER', 'STAFF', 'OWNER') NOT NULL,

    UNIQUE INDEX `Role_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Permission` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `resource` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Permission_resource_action_key`(`resource`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RolePermission` (
    `roleId` INTEGER NOT NULL,
    `permId` INTEGER NOT NULL,

    PRIMARY KEY (`roleId`, `permId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserRole` (
    `userId` INTEGER NOT NULL,
    `roleId` INTEGER NOT NULL,

    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Customer` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `stock` INTEGER NOT NULL DEFAULT 0,
    `stockThreshold` INTEGER NOT NULL DEFAULT 5,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Contract` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED', 'DEFAULTED') NOT NULL DEFAULT 'ACTIVE',
    `totalCents` INTEGER NOT NULL,
    `months` INTEGER NOT NULL,
    `startDate` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContractItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `contractId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `qty` INTEGER NOT NULL,
    `unitCents` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Installment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `contractId` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `dueDate` DATETIME(3) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'PAID', 'LATE') NOT NULL DEFAULT 'PENDING',
    `paidCents` INTEGER NOT NULL DEFAULT 0,

    INDEX `Installment_dueDate_status_idx`(`dueDate`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `installmentId` INTEGER NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `paidAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Payment_paidAt_idx`(`paidAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Document` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `type` ENUM('ID', 'CONTRACT', 'RECEIPT', 'OTHER') NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `size` INTEGER NOT NULL,
    `checksum` VARCHAR(191) NULL,
    `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(191) NOT NULL,
    `payload` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `replacedById` INTEGER NULL,

    INDEX `RefreshToken_userId_idx`(`userId`),
    INDEX `RefreshToken_tokenHash_idx`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_permId_fkey` FOREIGN KEY (`permId`) REFERENCES `Permission`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Contract` ADD CONSTRAINT `Contract_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ContractItem` ADD CONSTRAINT `ContractItem_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `Contract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ContractItem` ADD CONSTRAINT `ContractItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Installment` ADD CONSTRAINT `Installment_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `Contract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_installmentId_fkey` FOREIGN KEY (`installmentId`) REFERENCES `Installment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

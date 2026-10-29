import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';
import { runUnscoped } from '../../common/tenant/tenant-context';
import { defaultAutomationRuleRows } from './default-rules';

/**
 * BR-AUT-007: типові правила є в КОЖНІЙ організації — і в тій, що з'явилась поза `setup.service` і
 * міграцією даних (база, засіяна `seed.ts`: міграція йде до seed, коли організацій ще немає, а seed
 * не імпортує `@sto/shared`). На старті api дописує бракуючі правила; наявні не чіпає —
 * `skipDuplicates` над унікальною парою (orgId, systemKey). Вимкнене власником типове правило
 * лишається вимкненим (його рядок є), а видалити типове правило не можна (BR-AUT-007).
 *
 * Збій не зупиняє старт api: правила допишуться на наступному старті.
 */
@Injectable()
export class AutomationDefaultRulesBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutomationDefaultRulesBootstrap.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      await forEachActiveOrg(this.prisma, async orgIds => {
        // A1: крос-організаційний запис — явно поза tenant-scope.
        const res = await runUnscoped(() =>
          this.prisma.automationRule.createMany({
            data: orgIds.flatMap(orgId => defaultAutomationRuleRows(orgId)),
            skipDuplicates: true,
          }),
        );
        created += res.count;
      });
      if (created > 0) this.logger.log(`Типові правила автоматизації дописано: ${created}`);
    } catch (e: unknown) {
      this.logger.warn(
        `Типові правила автоматизації не дописано: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

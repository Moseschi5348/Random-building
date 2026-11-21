import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { HttpError } from "./http";

type CheckoutTarget =
  | { type: "MEMBERSHIP"; membershipId: string; label: string }
  | { type: "ACTIVITY"; activityRegistrationId: string; label: string };

export async function createCheckoutSession(
  prisma: PrismaClient,
  stripe: Stripe,
  clientUrl: string,
  userId: string,
  amountCents: number,
  target: CheckoutTarget,
): Promise<{ checkoutUrl: string; paymentId: string }> {
  if (amountCents <= 0) {
    throw new HttpError(400, "A payment is not required for this registration.");
  }

  const paymentData = {
    userId,
    type: target.type,
    amountCents,
    ...(target.type === "MEMBERSHIP"
      ? { membershipId: target.membershipId }
      : { activityRegistrationId: target.activityRegistrationId }),
  };
  const payment = await prisma.payment.create({ data: paymentData });
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: target.label },
          },
        },
      ],
      metadata: { paymentId: payment.id },
      success_url: `${clientUrl}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payments/cancel`,
    });
  } catch (error) {
    await prisma.payment.delete({ where: { id: payment.id } });
    throw error;
  }

  if (!session.url) {
    await prisma.payment.delete({ where: { id: payment.id } });
    throw new Error("Stripe did not return a checkout URL.");
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { stripeCheckoutSessionId: session.id },
  });
  return { checkoutUrl: session.url, paymentId: payment.id };
}

export async function applyStripeEvent(
  prisma: PrismaClient,
  event: Stripe.Event,
): Promise<void> {
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_failed" &&
    event.type !== "checkout.session.expired"
  ) {
    return;
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const paymentId = session.metadata?.paymentId;
  if (!paymentId) {
    throw new Error("Stripe checkout event is missing its payment reference.");
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.stripeCheckoutSessionId !== session.id) {
    throw new Error("Stripe checkout event does not match a known payment.");
  }
  if (payment.status !== "PENDING") {
    return;
  }

  if (event.type === "checkout.session.completed") {
    if (
      session.payment_status !== "paid" ||
      session.amount_total !== payment.amountCents ||
      session.currency !== payment.currency
    ) {
      throw new Error("Stripe payment details do not match the recorded payment.");
    }
  }

  await prisma.$transaction(async (tx) => {
    const status =
      event.type === "checkout.session.completed"
        ? "SUCCEEDED"
        : event.type === "checkout.session.expired"
          ? "EXPIRED"
          : "FAILED";
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status },
    });
    if (updated.count !== 1) {
      return;
    }

    if (event.type === "checkout.session.completed") {
      if (payment.membershipId) {
        await tx.membership.update({
          where: { id: payment.membershipId },
          data: { status: "ACTIVE" },
        });
      } else if (payment.activityRegistrationId) {
        await tx.activityRegistration.update({
          where: { id: payment.activityRegistrationId },
          data: { status: "CONFIRMED" },
        });
      } else {
        throw new Error("Payment has no registration target.");
      }
    } else if (payment.membershipId) {
      await tx.membership.update({
        where: { id: payment.membershipId },
        data: { status: "CANCELLED" },
      });
    } else if (payment.activityRegistrationId) {
      await tx.activityRegistration.update({
        where: { id: payment.activityRegistrationId },
        data: { status: "CANCELLED" },
      });
    }
  });
}

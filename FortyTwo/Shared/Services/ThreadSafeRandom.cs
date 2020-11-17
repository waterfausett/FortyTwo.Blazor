using System;
using System.Threading;

namespace FortyTwo.Shared.Services
{
    public static class ThreadSafeRandom
    {
        [ThreadStatic] private static Random Local;

        public static Random Instance
        {
            get => Local ??= new Random(unchecked(Environment.TickCount * 31 + Thread.CurrentThread.ManagedThreadId));
        }
    }
}

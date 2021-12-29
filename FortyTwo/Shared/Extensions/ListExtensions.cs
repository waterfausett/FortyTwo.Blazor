using System.Collections.Generic;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Services;

namespace FortyTwo.Shared.Extensions
{
    public static class ListExtensions
    {
        public static void Shuffle<T>(this IList<T> list)
        {
            int n = list.Count;
            while (n > 1)
            {
                n--;
                int k = ThreadSafeRandom.Instance.Next(n + 1);
                T value = list[k];
                list[k] = list[n];
                list[n] = value;
            }
        }

        public static void Shuffle(this IList<Domino> list, int iterations)
        {
            for (int i = 0; i < iterations; i++)
            {
                int n = list.Count;
                while (n > 1)
                {
                    n--;
                    int k = ThreadSafeRandom.Instance.Next(n + 1);
                    var value = list[k];
                    list[k] = list[n];
                    list[k].Orientation = (Orientation)ThreadSafeRandom.Instance.Next(2);
                    list[n] = value;
                    list[n].Orientation = (Orientation)ThreadSafeRandom.Instance.Next(2);
                }
            }
        }
    }
}

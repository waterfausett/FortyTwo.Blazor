using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.Mvc;
using System;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;

namespace FortyTwo.Server.Controllers.DataMining
{
    [Route("api/[controller]")]
    [ApiController]
    public class DataMiningController : ControllerBase
    {
        [HttpPost("samples/bids")]
        public async Task<IActionResult> BidSample([Required, FromBody] Bid bid)
        {
            await Task.Delay(TimeSpan.FromSeconds(2));

            return Ok();
        }
    }
}
